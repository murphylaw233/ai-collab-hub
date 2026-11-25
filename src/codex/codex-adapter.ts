import { z } from 'zod';
import {
  CODEX_REPORT_OUTPUT_SCHEMA,
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalRecord,
  type CodexRuntimeConfig,
  type CodexStructuredReport,
  type CodexTransportInfo,
  type ICodexRpcClient,
  type IncomingServerRequest,
  type InitializeResultSummary,
  type ProjectPermissionMode,
  type TaskMode,
} from '../types.js';

const StructuredReportSchema = z.object({
  verdict: z.enum(['completed', 'plan_concern', 'blocked']),
  summary: z.string(),
  risks_or_disagreements: z.array(z.string()),
  changed_files: z.array(z.string()),
  verification_output: z.string(),
  next_suggested_action: z.string().nullable(),
});

export interface SanitizedAccountInfo {
  authenticated: boolean;
  requiresOpenaiAuth: boolean;
  accountType: string | null;
  planType: string | null;
  workspaceName: string | null;
}

export interface StartThreadInput {
  cwd: string;
  mode: TaskMode;
  permissionMode: ProjectPermissionMode;
  model?: string;
}

export interface StartThreadResult {
  threadId: string;
  model: string | null;
  modelProvider: string | null;
}

export interface StartTurnInput {
  threadId: string;
  prompt: string;
  mode: TaskMode;
  cwd: string;
  model?: string;
  useStructuredOutput?: boolean;
}

export interface NormalizedApprovalRequest {
  rpcRequestId: string | number;
  threadId: string;
  turnId: string | null;
  kind: ApprovalKind;
  summary: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  rawParams: Record<string, unknown>;
}

export type NormalizedCodexEvent =
  | { kind: 'thread_started'; threadId: string; raw: Record<string, unknown> }
  | { kind: 'turn_started'; threadId: string; turnId: string; raw: Record<string, unknown> }
  | { kind: 'plan_updated'; threadId: string; turnId: string | null; explanation: string | null; plan: unknown[] }
  | { kind: 'reasoning_summary'; threadId: string; turnId: string | null; itemId: string | null; delta: string }
  | { kind: 'command_started'; threadId: string; turnId: string | null; itemId: string | null; item: Record<string, unknown> }
  | { kind: 'command_output'; threadId: string; turnId: string | null; itemId: string | null; delta: string }
  | { kind: 'command_completed'; threadId: string; turnId: string | null; itemId: string | null; item: Record<string, unknown> }
  | { kind: 'file_change_updated'; threadId: string; turnId: string | null; itemId: string | null; changes: unknown[]; status?: string }
  | { kind: 'diff_updated'; threadId: string; turnId: string | null; diff: string }
  | { kind: 'agent_message_delta'; threadId: string; turnId: string | null; itemId: string | null; delta: string }
  | { kind: 'agent_message'; threadId: string; turnId: string | null; itemId: string | null; text: string }
  | { kind: 'token_usage'; threadId: string; turnId: string | null; tokenUsage: Record<string, unknown> }
  | { kind: 'warning'; threadId: string | null; message: string; raw: Record<string, unknown> }
  | { kind: 'error'; threadId: string | null; turnId: string | null; message: string; raw: Record<string, unknown> }
  | { kind: 'turn_completed'; threadId: string; turnId: string | null; status: string; error: string | null; turn: Record<string, unknown> };

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function formatCommand(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' ');
  return null;
}

export function buildWrappedPrompt(mode: TaskMode, userPrompt: string): string {
  const modeHeader =
    mode === 'precheck'
      ? [
          'MODE: PRECHECK (READ-ONLY FEASIBILITY & RISK REVIEW).',
          'Do NOT modify any files or run destructive/write commands.',
          'Inspect the repository, verify assumptions, and challenge any flaws, ambiguities, or hidden risks in the plan.',
          'Set verdict to "plan_concern" or "blocked" if you find technical flaws or missing prerequisites.',
        ].join(' ')
      : mode === 'readonly_research'
        ? [
            'MODE: READ-ONLY RESEARCH & EXTRACTION.',
            'Do NOT modify any files.',
            'Scan/analyze the requested workspace files concisely and accurately, citing exact file paths and symbols.',
          ].join(' ')
        : [
            'MODE: EXECUTE (SCOPED ENGINEERING TASK ON NATIVE WINDOWS).',
            'You are collaborating with Gemini/Antigravity — do not blindly execute flawed instructions.',
            'If the plan is flawed, unsafe, or contradicted by the codebase, stop/avoid risky changes and report verdict "plan_concern" or "blocked" with details in risks_or_disagreements.',
            'When implementing, prefer Windows/PowerShell-compatible commands and run relevant verification checks before finishing.',
          ].join(' ');

  const utf8Hint =
    'Windows/PowerShell UTF-8: PYTHONUTF8=1 and PYTHONIOENCODING=utf-8 are set. When running PowerShell on non-ASCII/Chinese paths or text, prefix with "$OutputEncoding=[Text.UTF8Encoding]::new($false); try { [Console]::OutputEncoding=$OutputEncoding } catch {}" and pass "-Encoding utf8" for Get-Content/Set-Content (or use Python).';

  return `${modeHeader}\n${utf8Hint}\n\nUSER TASK:\n${userPrompt}`;
}

export function tryParseStructuredReport(text: string | null): CodexStructuredReport | null {
  if (!text) return null;
  const trimmed = text.trim();
  const candidates = [trimmed];
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenceMatch?.[1]) {
    candidates.push(fenceMatch[1].trim());
  }
  for (const candidate of candidates) {
    try {
      const parsedJson = JSON.parse(candidate);
      const parsed = StructuredReportSchema.safeParse(parsedJson);
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      // Continue checking candidates
    }
  }
  return null;
}

/**
 * Adapter translating high-level Hub orchestration commands and approvals
 * onto the codex app-server JSON-RPC protocol.
 */
export class CodexAdapter {
  private readonly eventListeners = new Set<(event: NormalizedCodexEvent) => void>();
  private readonly approvalListeners = new Set<(req: NormalizedApprovalRequest) => void>();
  private readonly exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();
  private readonly pendingRpcIds = new Map<string, string | number>();
  private unsubRpc: Array<() => void> = [];

  constructor(
    private readonly rpc: ICodexRpcClient,
    private readonly config: CodexRuntimeConfig
  ) {
    this.unsubRpc.push(
      this.rpc.onNotification((method, params) => this.handleNotification(method, params)),
      this.rpc.onServerRequest((req) => this.handleServerRequest(req)),
      this.rpc.onExit((info) => {
        for (const listener of this.exitListeners) listener(info);
      })
    );
  }

  async start(): Promise<InitializeResultSummary> {
    return this.rpc.start();
  }

  async stop(): Promise<void> {
    for (const unsub of this.unsubRpc) unsub();
    this.unsubRpc = [];
    this.pendingRpcIds.clear();
    await this.rpc.stop();
  }

  isRunning(): boolean {
    return this.rpc.isRunning();
  }

  getTransportInfo(): CodexTransportInfo {
    return this.rpc.getTransportInfo();
  }

  async readAccount(): Promise<SanitizedAccountInfo> {
    const raw = asRecord(await this.rpc.request('account/read', { refreshToken: false }));
    const acct = asRecord(raw.account);
    const hasAccount = raw.account !== null && raw.account !== undefined && Object.keys(acct).length > 0;
    return {
      authenticated: hasAccount,
      requiresOpenaiAuth: Boolean(raw.requiresOpenaiAuth),
      accountType: asString(acct.type),
      planType: asString(acct.planType),
      workspaceName: asString(acct.workspaceName),
    };
  }

  async startThread(input: StartThreadInput): Promise<StartThreadResult> {
    if (input.mode === 'execute' && input.permissionMode !== 'codex_work') {
      throw new Error(`Project permissionMode "${input.permissionMode}" forbids execute mode`);
    }
    const sandbox =
      input.mode === 'execute'
        ? this.config.defaultSandbox === 'read-only'
          ? 'workspace-write'
          : this.config.defaultSandbox
        : 'read-only';

    const params: Record<string, unknown> = {
      cwd: input.cwd,
      sandbox,
      approvalPolicy: this.config.defaultApprovalPolicy,
      ephemeral: this.config.ephemeralThreads,
      serviceName: 'ai-collab-hub',
    };
    const model = input.model ?? this.config.defaultModel;
    if (model) params.model = model;

    const raw = asRecord(await this.rpc.request('thread/start', params));
    const thread = asRecord(raw.thread);
    const threadId = asString(thread.id) ?? asString(raw.threadId);
    if (!threadId) {
      throw new Error('codex thread/start did not return a thread id');
    }
    return {
      threadId,
      model: asString(raw.model) ?? asString(thread.model),
      modelProvider: asString(raw.modelProvider) ?? asString(thread.modelProvider),
    };
  }

  async resumeThread(threadId: string, cwd: string): Promise<void> {
    await this.rpc.request('thread/resume', {
      threadId,
      cwd,
      excludeTurns: true,
    });
  }

  async startTurn(input: StartTurnInput): Promise<{ turnId: string }> {
    const params: Record<string, unknown> = {
      threadId: input.threadId,
      cwd: input.cwd,
      input: [
        {
          type: 'text',
          text: buildWrappedPrompt(input.mode, input.prompt),
        },
      ],
    };
    if (input.model) params.model = input.model;
    if (input.useStructuredOutput !== false) {
      params.outputSchema = CODEX_REPORT_OUTPUT_SCHEMA;
    }

    const raw = asRecord(await this.rpc.request('turn/start', params));
    const turn = asRecord(raw.turn);
    const turnId = asString(turn.id) ?? asString(raw.turnId);
    if (!turnId) {
      throw new Error('codex turn/start did not return a turn id');
    }
    return { turnId };
  }

  async steerTurn(threadId: string, expectedTurnId: string, prompt: string): Promise<void> {
    await this.rpc.request('turn/steer', {
      threadId,
      expectedTurnId,
      input: [{ type: 'text', text: prompt }],
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request('turn/interrupt', { threadId, turnId });
  }

  trackApprovalRpcId(approvalId: string, rpcRequestId: string | number): void {
    this.pendingRpcIds.set(approvalId, rpcRequestId);
  }

  replyApproval(approval: ApprovalRecord, decision: ApprovalDecision): void {
    const rpcId = this.pendingRpcIds.get(approval.id) ?? approval.rpcRequestId;
    this.pendingRpcIds.delete(approval.id);

    switch (approval.kind) {
      case 'command':
      case 'file_change':
        this.rpc.respondToServerRequest(rpcId, { decision });
        break;
      case 'permissions': {
        const granted = decision === 'accept' || decision === 'acceptForSession';
        this.rpc.respondToServerRequest(rpcId, {
          permissions: granted ? (approval.rawParams.permissions ?? {}) : {},
          scope: decision === 'acceptForSession' ? 'session' : 'turn',
        });
        break;
      }
      default:
        this.rpc.rejectServerRequest(rpcId, -32000, `Unsupported approval kind: ${approval.kind}`);
        break;
    }
  }

  rejectApprovalIfPending(approvalId: string, fallbackRpcRequestId: string, message: string): void {
    const rpcId = this.pendingRpcIds.get(approvalId) ?? fallbackRpcRequestId;
    this.pendingRpcIds.delete(approvalId);
    try {
      this.rpc.rejectServerRequest(rpcId, -32000, message);
    } catch {
      // Ignore if RPC client is already closed
    }
  }

  onEvent(handler: (event: NormalizedCodexEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  onApprovalRequest(handler: (req: NormalizedApprovalRequest) => void): () => void {
    this.approvalListeners.add(handler);
    return () => this.approvalListeners.delete(handler);
  }

  onExit(handler: (info: { code: number | null; signal: string | null }) => void): () => void {
    this.exitListeners.add(handler);
    return () => this.exitListeners.delete(handler);
  }

  private emitEvent(event: NormalizedCodexEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const p = asRecord(rawParams);
    const threadId = asString(p.threadId) ?? asString(asRecord(p.thread).id);
    const turnId = asString(p.turnId) ?? asString(asRecord(p.turn).id);
    const itemId = asString(p.itemId) ?? asString(asRecord(p.item).id);

    switch (method) {
      case 'thread/started':
        if (threadId) this.emitEvent({ kind: 'thread_started', threadId, raw: p });
        break;
      case 'turn/started':
        if (threadId && turnId) this.emitEvent({ kind: 'turn_started', threadId, turnId, raw: p });
        break;
      case 'turn/plan/updated':
        if (threadId) {
          this.emitEvent({
            kind: 'plan_updated',
            threadId,
            turnId,
            explanation: asString(p.explanation),
            plan: Array.isArray(p.plan) ? p.plan : [],
          });
        }
        break;
      case 'item/reasoning/summaryTextDelta':
        if (threadId && typeof p.delta === 'string') {
          this.emitEvent({
            kind: 'reasoning_summary',
            threadId,
            turnId,
            itemId,
            delta: p.delta,
          });
        }
        break;
      case 'item/started': {
        if (!threadId) break;
        const item = asRecord(p.item);
        if (item.type === 'commandExecution') {
          this.emitEvent({ kind: 'command_started', threadId, turnId, itemId, item });
        }
        break;
      }
      case 'item/commandExecution/outputDelta':
        if (threadId && typeof p.delta === 'string') {
          this.emitEvent({
            kind: 'command_output',
            threadId,
            turnId,
            itemId,
            delta: p.delta,
          });
        }
        break;
      case 'item/completed': {
        if (!threadId) break;
        const item = asRecord(p.item);
        if (item.type === 'commandExecution') {
          this.emitEvent({ kind: 'command_completed', threadId, turnId, itemId, item });
        } else if (item.type === 'fileChange') {
          this.emitEvent({
            kind: 'file_change_updated',
            threadId,
            turnId,
            itemId,
            changes: Array.isArray(item.changes) ? item.changes : [],
            status: asString(item.status) ?? undefined,
          });
        } else if (item.type === 'agentMessage' && typeof item.text === 'string') {
          this.emitEvent({
            kind: 'agent_message',
            threadId,
            turnId,
            itemId,
            text: item.text,
          });
        }
        break;
      }
      case 'item/fileChange/patchUpdated':
        if (threadId) {
          this.emitEvent({
            kind: 'file_change_updated',
            threadId,
            turnId,
            itemId,
            changes: Array.isArray(p.changes) ? p.changes : [],
          });
        }
        break;
      case 'turn/diff/updated':
        if (threadId && typeof p.diff === 'string') {
          this.emitEvent({ kind: 'diff_updated', threadId, turnId, diff: p.diff });
        }
        break;
      case 'item/agentMessage/delta':
        if (threadId && typeof p.delta === 'string') {
          this.emitEvent({
            kind: 'agent_message_delta',
            threadId,
            turnId,
            itemId,
            delta: p.delta,
          });
        }
        break;
      case 'thread/tokenUsage/updated':
        if (threadId) {
          this.emitEvent({
            kind: 'token_usage',
            threadId,
            turnId,
            tokenUsage: asRecord(p.tokenUsage ?? p),
          });
        }
        break;
      case 'warning':
        this.emitEvent({
          kind: 'warning',
          threadId,
          message: asString(p.message) ?? JSON.stringify(p),
          raw: p,
        });
        break;
      case 'error': {
        const errObj = asRecord(p.error);
        this.emitEvent({
          kind: 'error',
          threadId,
          turnId,
          message: asString(errObj.message) ?? asString(p.message) ?? JSON.stringify(p),
          raw: p,
        });
        break;
      }
      case 'turn/completed': {
        if (!threadId) break;
        const turn = asRecord(p.turn);
        const turnErr = asRecord(turn.error);
        this.emitEvent({
          kind: 'turn_completed',
          threadId,
          turnId: asString(turn.id) ?? turnId,
          status: asString(turn.status) ?? 'completed',
          error: asString(turnErr.message) ?? asString(turn.error),
          turn,
        });
        break;
      }
      default:
        break;
    }
  }

  private handleServerRequest(req: IncomingServerRequest): void {
    const p = asRecord(req.params);
    const threadId = asString(p.threadId);
    const turnId = asString(p.turnId);

    if (req.method === 'item/commandExecution/requestApproval' || req.method === 'execCommandApproval') {
      const command = formatCommand(p.command);
      const cwd = asString(p.cwd);
      const reason = asString(p.reason);
      if (!threadId || this.approvalListeners.size === 0) {
        this.rpc.respondToServerRequest(req.id, { decision: 'decline' });
        return;
      }
      const normalized: NormalizedApprovalRequest = {
        rpcRequestId: req.id,
        threadId,
        turnId,
        kind: 'command',
        summary: command ? `Run command: ${command}` : 'Approve command execution',
        command,
        cwd,
        reason,
        rawParams: p,
      };
      for (const listener of this.approvalListeners) listener(normalized);
      return;
    }

    if (req.method === 'item/fileChange/requestApproval' || req.method === 'applyPatchApproval') {
      const reason = asString(p.reason);
      const grantRoot = asString(p.grantRoot);
      if (!threadId || this.approvalListeners.size === 0) {
        this.rpc.respondToServerRequest(req.id, { decision: 'decline' });
        return;
      }
      const normalized: NormalizedApprovalRequest = {
        rpcRequestId: req.id,
        threadId,
        turnId,
        kind: 'file_change',
        summary: grantRoot ? `Approve file change under ${grantRoot}` : 'Approve file change',
        command: null,
        cwd: grantRoot,
        reason,
        rawParams: p,
      };
      for (const listener of this.approvalListeners) listener(normalized);
      return;
    }

    if (req.method === 'item/permissions/requestApproval') {
      const cwd = asString(p.cwd);
      const reason = asString(p.reason);
      if (!threadId || this.approvalListeners.size === 0) {
        this.rpc.respondToServerRequest(req.id, { permissions: {}, scope: 'turn' });
        return;
      }
      const normalized: NormalizedApprovalRequest = {
        rpcRequestId: req.id,
        threadId,
        turnId,
        kind: 'permissions',
        summary: reason ? `Permission request: ${reason}` : 'Approve additional permission profile',
        command: null,
        cwd,
        reason,
        rawParams: p,
      };
      for (const listener of this.approvalListeners) listener(normalized);
      return;
    }

    this.rpc.rejectServerRequest(req.id, -32601, `Unsupported server request: ${req.method}`);
  }
}
