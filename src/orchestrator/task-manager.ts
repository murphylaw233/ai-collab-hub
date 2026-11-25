import { createHash, randomUUID } from 'node:crypto';
import type {
  ApprovalDecision,
  ApprovalRecord,
  ClientOrigin,
  CodexStructuredReport,
  HubConfig,
  IFileSandbox,
  ITaskStore,
  ListTasksFilter,
  TaskEventRecord,
  TaskEventType,
  TaskMode,
  TaskRecord,
  TaskStatus,
} from '../types.js';
import {
  CodexAdapter,
  tryParseStructuredReport,
  type NormalizedApprovalRequest,
  type NormalizedCodexEvent,
} from '../codex/codex-adapter.js';

export interface SubmitTaskInput {
  origin: ClientOrigin;
  projectId: string;
  mode: TaskMode;
  prompt: string;
  idempotencyKey?: string;
  model?: string;
}

export interface SubmitTaskResult {
  task: TaskRecord;
  deduplicated: boolean;
  resumeCommand: string | null;
}

export interface FollowupTaskInput {
  origin: ClientOrigin;
  taskId: string;
  prompt: string;
  mode?: TaskMode;
  model?: string;
}

export type TaskPhase =
  | 'queued'
  | 'thinking'
  | 'running_command'
  | 'editing_files'
  | 'writing_response'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskProgressSummary {
  phase: TaskPhase;
  turnElapsedSec: number | null;
  activeCommand: string | null;
  activeCommandElapsedSec: number | null;
  lastCommand: {
    command: string;
    exitCode: number | null;
    durationMs: number | null;
  } | null;
  latestInterimText: string | null;
  softTimeoutTriggered: boolean;
}

export interface ContextUsageSummary {
  lastTurnTokens: number | null;
  totalTokens: number | null;
  modelContextWindow: number | null;
  utilizationPercent: number | null;
  pressure: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
  recommendation: string | null;
}

export interface CompactedTaskEvent {
  seq: number;
  type: TaskEventType;
  createdAt: number;
  summary: string;
  mergedCount?: number;
}

export interface WaitTaskResult {
  task: TaskRecord;
  approvals: ApprovalRecord[];
  recentEvents: TaskEventRecord[];
  compactedEvents: CompactedTaskEvent[];
  lastSeq: number;
  progress: TaskProgressSummary;
  contextUsage: ContextUsageSummary;
  resumeCommand: string | null;
  timedOut: boolean;
}

export interface TaskDetailResult {
  task: TaskRecord;
  approvals: ApprovalRecord[];
  resumeCommand: string | null;
}

export interface HealthSummary {
  ok: boolean;
  codexRunning: boolean;
  transport: string;
  wsUrl: string | null;
  pendingApprovalsCount: number;
  runningTasksCount: number;
}

export type TaskStreamMessage =
  | { kind: 'task_event'; data: TaskEventRecord }
  | { kind: 'task_snapshot'; data: TaskDetailResult }
  | { kind: 'approval_update'; data: ApprovalRecord };

interface DeltaBuffer {
  key: string;
  taskId: string;
  type: 'command_output' | 'agent_message_delta' | 'reasoning_summary';
  turnId: string | null;
  itemId: string | null;
  chunks: string[];
  timer: NodeJS.Timeout;
}

interface TurnRuntimeState {
  phase: TaskPhase;
  turnStartedAt: number;
  activeCommand: string | null;
  activeCommandStartedAt: number | null;
  lastCommand: {
    command: string;
    exitCode: number | null;
    durationMs: number | null;
  } | null;
  latestInterimText: string | null;
  softTimeoutTriggered: boolean;
}

const TERMINAL_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'CANCELLED']);
const WAIT_STOP_STATUSES = new Set<TaskStatus>(['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_APPROVAL']);
const STREAMING_DELTA_TYPES = new Set<TaskEventType>([
  'agent_message_delta',
  'reasoning_summary',
  'command_output',
]);

function truncateSingleLine(text: string, maxLength = 240): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3))}...`;
}

function tailSingleLine(text: string, maxLength = 400): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `...${normalized.slice(-(maxLength - 3))}`;
}

function extractCommandString(item: Record<string, unknown> | undefined): string {
  if (!item) return 'unknown command';
  const raw = item.command;
  if (typeof raw === 'string' && raw.trim()) return truncateSingleLine(raw, 140);
  if (Array.isArray(raw) && raw.length > 0) {
    return truncateSingleLine(raw.map((part) => String(part)).join(' '), 140);
  }
  return 'unknown command';
}

export function computeContextUsage(tokenUsageJson: string | null): ContextUsageSummary {
  if (!tokenUsageJson) {
    return {
      lastTurnTokens: null,
      totalTokens: null,
      modelContextWindow: null,
      utilizationPercent: null,
      pressure: 'unknown',
      recommendation: null,
    };
  }
  try {
    const parsed = JSON.parse(tokenUsageJson) as Record<string, unknown>;
    const last =
      parsed.last && typeof parsed.last === 'object' ? (parsed.last as Record<string, unknown>) : null;
    const total =
      parsed.total && typeof parsed.total === 'object' ? (parsed.total as Record<string, unknown>) : null;

    const lastTurnTokens =
      typeof last?.totalTokens === 'number' && Number.isFinite(last.totalTokens)
        ? last.totalTokens
        : null;
    const totalTokens =
      typeof total?.totalTokens === 'number' && Number.isFinite(total.totalTokens)
        ? total.totalTokens
        : null;
    const modelContextWindow =
      typeof parsed.modelContextWindow === 'number' && Number.isFinite(parsed.modelContextWindow)
        ? parsed.modelContextWindow
        : null;

    const utilizationPercent =
      lastTurnTokens !== null && modelContextWindow !== null && modelContextWindow > 0
        ? Math.min(100, Math.round((lastTurnTokens / modelContextWindow) * 1000) / 10)
        : null;

    if (utilizationPercent === null) {
      return {
        lastTurnTokens,
        totalTokens,
        modelContextWindow,
        utilizationPercent: null,
        pressure: 'unknown',
        recommendation: null,
      };
    }

    if (utilizationPercent >= 80) {
      return {
        lastTurnTokens,
        totalTokens,
        modelContextWindow,
        utilizationPercent,
        pressure: 'critical',
        recommendation:
          'Context window is critically full (>=80%). Start a fresh codex_submit task instead of codex_followup to avoid timeouts or degraded reasoning.',
      };
    }
    if (utilizationPercent >= 65) {
      return {
        lastTurnTokens,
        totalTokens,
        modelContextWindow,
        utilizationPercent,
        pressure: 'high',
        recommendation:
          'Context utilization is high (>=65%). Consider starting a fresh codex_submit task for new investigations.',
      };
    }
    if (utilizationPercent >= 40) {
      return {
        lastTurnTokens,
        totalTokens,
        modelContextWindow,
        utilizationPercent,
        pressure: 'medium',
        recommendation: null,
      };
    }
    return {
      lastTurnTokens,
      totalTokens,
      modelContextWindow,
      utilizationPercent,
      pressure: 'low',
      recommendation: null,
    };
  } catch {
    return {
      lastTurnTokens: null,
      totalTokens: null,
      modelContextWindow: null,
      utilizationPercent: null,
      pressure: 'unknown',
      recommendation: null,
    };
  }
}

function summarizeEventText(event: TaskEventRecord): string {
  const p = event.payload;
  switch (event.type) {
    case 'command_started': {
      const item = p.item && typeof p.item === 'object' ? (p.item as Record<string, unknown>) : undefined;
      return `Running: ${extractCommandString(item)}`;
    }
    case 'command_completed': {
      const item = p.item && typeof p.item === 'object' ? (p.item as Record<string, unknown>) : undefined;
      const cmd = extractCommandString(item);
      const exitCode = typeof item?.exitCode === 'number' ? item.exitCode : null;
      const durationMs = typeof item?.durationMs === 'number' ? item.durationMs : null;
      const stats = [
        exitCode !== null ? `exit=${exitCode}` : null,
        durationMs !== null ? `${durationMs}ms` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return stats ? `Completed (${stats}): ${cmd}` : `Completed: ${cmd}`;
    }
    case 'file_change_updated': {
      const count = Array.isArray(p.changes) ? p.changes.length : 0;
      const status = typeof p.status === 'string' ? ` [${p.status}]` : '';
      return `File changes (${count})${status}`;
    }
    case 'diff_updated': {
      const diff = typeof p.diff === 'string' ? p.diff : '';
      return `Updated git diff (${Buffer.byteLength(diff, 'utf8')} bytes)`;
    }
    case 'plan_updated': {
      const steps = Array.isArray(p.plan) ? p.plan.length : 0;
      const explanation = typeof p.explanation === 'string' ? p.explanation : '';
      return truncateSingleLine(
        explanation ? `Plan (${steps} steps): ${explanation}` : `Plan updated (${steps} steps)`
      );
    }
    case 'task_status': {
      const status = typeof p.status === 'string' ? p.status : 'unknown';
      const err = typeof p.error === 'string' ? `: ${p.error}` : '';
      const reason = typeof p.reason === 'string' ? ` (${p.reason})` : '';
      return truncateSingleLine(`Status -> ${status}${reason}${err}`);
    }
    case 'turn_started':
      return truncateSingleLine(`Turn started (${typeof p.turnId === 'string' ? p.turnId : ''})`);
    case 'turn_completed': {
      const status = typeof p.status === 'string' ? p.status : 'completed';
      const verdict = typeof p.verdict === 'string' ? `, verdict=${p.verdict}` : '';
      const err = typeof p.error === 'string' ? `, error=${p.error}` : '';
      return truncateSingleLine(`Turn ${status}${verdict}${err}`);
    }
    case 'approval_requested': {
      const kind = typeof p.kind === 'string' ? p.kind : 'approval';
      const summary = typeof p.summary === 'string' ? p.summary : '';
      return truncateSingleLine(`Approval requested (${kind}): ${summary}`);
    }
    case 'approval_resolved': {
      const decision = typeof p.decision === 'string' ? p.decision : '';
      return truncateSingleLine(`Approval resolved: ${decision}`);
    }
    default: {
      const raw =
        (typeof p.delta === 'string' && p.delta) ||
        (typeof p.text === 'string' && p.text) ||
        (typeof p.message === 'string' && p.message) ||
        (typeof p.summary === 'string' && p.summary) ||
        (typeof p.error === 'string' && p.error) ||
        JSON.stringify(p);
      return truncateSingleLine(raw);
    }
  }
}

export function compactEventsForWait(events: TaskEventRecord[], maxItems = 15): CompactedTaskEvent[] {
  interface Accumulator {
    seq: number;
    type: TaskEventType;
    createdAt: number;
    turnId: string | null;
    itemId: string | null;
    rawText: string;
    mergedCount: number;
  }

  const compacted: Accumulator[] = [];
  for (const ev of events) {
    if (ev.type === 'token_usage') continue;

    if (STREAMING_DELTA_TYPES.has(ev.type)) {
      const delta = typeof ev.payload.delta === 'string' ? ev.payload.delta : summarizeEventText(ev);
      const prev = compacted[compacted.length - 1];
      if (
        prev &&
        prev.type === ev.type &&
        prev.turnId === ev.turnId &&
        prev.itemId === ev.itemId
      ) {
        prev.seq = ev.seq;
        prev.createdAt = ev.createdAt;
        prev.rawText += delta;
        prev.mergedCount += 1;
        continue;
      }
      compacted.push({
        seq: ev.seq,
        type: ev.type,
        createdAt: ev.createdAt,
        turnId: ev.turnId,
        itemId: ev.itemId,
        rawText: delta,
        mergedCount: 1,
      });
      continue;
    }

    compacted.push({
      seq: ev.seq,
      type: ev.type,
      createdAt: ev.createdAt,
      turnId: ev.turnId,
      itemId: ev.itemId,
      rawText: summarizeEventText(ev),
      mergedCount: 1,
    });
  }

  return compacted.slice(-maxItems).map((item) => ({
    seq: item.seq,
    type: item.type,
    createdAt: item.createdAt,
    summary: truncateSingleLine(item.rawText),
    ...(item.mergedCount > 1 ? { mergedCount: item.mergedCount } : {}),
  }));
}

function formatResumeCommand(threadId: string | null): string | null {
  return threadId ? `codex resume ${threadId}` : null;
}

function hashPrompt(mode: TaskMode, prompt: string): string {
  return createHash('sha256').update(`${mode}\n${prompt.trim()}`).digest('hex');
}

function extractTextFromTurnItems(turn: Record<string, unknown>): string | null {
  const items = turn.items;
  if (!Array.isArray(items)) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      if (rec.type === 'agentMessage' && typeof rec.text === 'string' && rec.text.trim()) {
        return rec.text;
      }
    }
  }
  return null;
}

export class TaskManager {
  private readonly threadToTaskId = new Map<string, string>();
  private readonly projectWriteLocks = new Map<string, string>();
  private readonly streamListeners = new Map<string, Set<(msg: TaskStreamMessage) => void>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly deltaBuffers = new Map<string, DeltaBuffer>();
  private readonly turnTimers = new Map<string, NodeJS.Timeout>();
  private readonly softTurnTimers = new Map<string, NodeJS.Timeout>();
  private readonly runtimeStates = new Map<string, TurnRuntimeState>();
  private readonly lastTaskSeq = new Map<string, number>();
  private readonly commandByteCounts = new Map<string, number>();
  private readonly commandTruncated = new Set<string>();
  private readonly agentTextBuffers = new Map<string, string>();
  private readonly unsubs: Array<() => void> = [];
  private startingPromise: Promise<void> | null = null;
  private shutDown = false;

  constructor(
    private readonly store: ITaskStore,
    private readonly sandbox: IFileSandbox,
    private readonly adapter: CodexAdapter,
    private readonly config: HubConfig
  ) {
    this.unsubs.push(
      this.adapter.onEvent((event) => this.handleCodexEvent(event)),
      this.adapter.onApprovalRequest((req) => this.handleApprovalRequest(req)),
      this.adapter.onExit((info) => this.handleAdapterExit(info))
    );
  }

  async ensureStarted(): Promise<void> {
    if (this.shutDown) throw new Error('TaskManager is shut down');
    if (this.adapter.isRunning()) return;
    if (!this.startingPromise) {
      this.startingPromise = this.adapter
        .start()
        .then(() => undefined)
        .finally(() => {
          this.startingPromise = null;
        });
    }
    await this.startingPromise;
  }

  getHealthSummary(): HealthSummary {
    const transportInfo = this.adapter.getTransportInfo();
    const pendingApprovalsCount = this.store.listPendingApprovals().length;
    const runningTasksCount =
      this.store.listTasks({ status: 'RUNNING', limit: 200 }).length +
      this.store.listTasks({ status: 'WAITING_APPROVAL', limit: 200 }).length;
    return {
      ok: !this.shutDown,
      codexRunning: this.adapter.isRunning(),
      transport: transportInfo.transport,
      wsUrl: transportInfo.wsUrl,
      pendingApprovalsCount,
      runningTasksCount,
    };
  }

  listTasks(filter?: ListTasksFilter): TaskRecord[] {
    return this.store.listTasks(filter);
  }

  getTaskDetail(taskId: string): TaskDetailResult | null {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    return {
      task,
      approvals: this.store.listApprovalsForTask(taskId),
      resumeCommand: formatResumeCommand(task.threadId),
    };
  }

  getTaskEvents(taskId: string, afterSeq = 0, limit = 500): TaskEventRecord[] {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return this.store.listEvents(taskId, afterSeq, limit);
  }

  getTaskProgress(task: TaskRecord): TaskProgressSummary {
    const runtime = this.runtimeStates.get(task.id);
    const now = Date.now();
    if (!runtime) {
      const fallbackPhase: TaskPhase =
        task.status === 'QUEUED'
          ? 'queued'
          : task.status === 'WAITING_APPROVAL'
            ? 'waiting_approval'
            : task.status === 'COMPLETED'
              ? 'completed'
              : task.status === 'FAILED'
                ? 'failed'
                : task.status === 'CANCELLED'
                  ? 'cancelled'
                  : 'thinking';
      return {
        phase: fallbackPhase,
        turnElapsedSec:
          task.status === 'RUNNING' || task.status === 'WAITING_APPROVAL'
            ? Math.max(0, Math.round(((now - task.updatedAt) / 1000) * 10) / 10)
            : null,
        activeCommand: null,
        activeCommandElapsedSec: null,
        lastCommand: null,
        latestInterimText: null,
        softTimeoutTriggered: false,
      };
    }

    const isActive = !TERMINAL_STATUSES.has(task.status);
    const effectivePhase: TaskPhase =
      task.status === 'COMPLETED'
        ? 'completed'
        : task.status === 'FAILED'
          ? 'failed'
          : task.status === 'CANCELLED'
            ? 'cancelled'
            : task.status === 'WAITING_APPROVAL'
              ? 'waiting_approval'
              : runtime.phase;
    return {
      phase: effectivePhase,
      turnElapsedSec: isActive
        ? Math.max(0, Math.round(((now - runtime.turnStartedAt) / 1000) * 10) / 10)
        : null,
      activeCommand: isActive ? runtime.activeCommand : null,
      activeCommandElapsedSec:
        isActive && runtime.activeCommand && runtime.activeCommandStartedAt !== null
          ? Math.max(0, Math.round(((now - runtime.activeCommandStartedAt) / 1000) * 10) / 10)
          : null,
      lastCommand: runtime.lastCommand,
      latestInterimText: runtime.latestInterimText,
      softTimeoutTriggered: runtime.softTimeoutTriggered,
    };
  }

  private listEventsPaged(taskId: string, afterSeq = 0, maxTotal = 5000): TaskEventRecord[] {
    const collected: TaskEventRecord[] = [];
    let cursor = Math.max(0, Math.floor(afterSeq));
    while (collected.length < maxTotal) {
      const batchSize = Math.min(500, maxTotal - collected.length);
      const batch = this.store.listEvents(taskId, cursor, batchSize);
      if (batch.length === 0) break;
      collected.push(...batch);
      cursor = batch[batch.length - 1].seq;
      if (batch.length < batchSize) break;
    }
    return collected;
  }

  private getLatestSeq(taskId: string): number {
    const cached = this.lastTaskSeq.get(taskId);
    if (cached !== undefined) return cached;
    const all = this.listEventsPaged(taskId, 0, 5000);
    const seq = all.length > 0 ? all[all.length - 1].seq : 0;
    this.lastTaskSeq.set(taskId, seq);
    return seq;
  }

  subscribeTask(taskId: string, listener: (msg: TaskStreamMessage) => void): () => void {
    let set = this.streamListeners.get(taskId);
    if (!set) {
      set = new Set();
      this.streamListeners.set(taskId, set);
    }
    set.add(listener);
    return () => {
      const current = this.streamListeners.get(taskId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.streamListeners.delete(taskId);
    };
  }

  submitTask(input: SubmitTaskInput): SubmitTaskResult {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Task prompt must not be empty');

    const project = this.sandbox.getProject(input.projectId);
    if (input.mode === 'execute' && project.permissionMode !== 'codex_work') {
      throw new Error(
        `Project "${project.id}" has permissionMode="${project.permissionMode}", which forbids execute mode`
      );
    }

    const promptHash = hashPrompt(input.mode, prompt);
    const sinceMs = Date.now() - this.config.guardrails.idempotencyCooldownMs;
    const duplicate = this.store.findRecentDuplicateTask({
      idempotencyKey: input.idempotencyKey,
      projectId: input.projectId,
      promptHash,
      threadId: null,
      sinceMs,
    });
    if (duplicate) {
      this.store.appendAuditLog({
        origin: input.origin,
        actor: input.origin,
        action: 'task_deduplicated',
        projectId: input.projectId,
        taskId: duplicate.id,
        detail: { idempotencyKey: input.idempotencyKey ?? null },
      });
      return {
        task: duplicate,
        deduplicated: true,
        resumeCommand: formatResumeCommand(duplicate.threadId),
      };
    }

    if (input.mode === 'execute') {
      this.acquireWriteLock(input.projectId, 'pending');
    }

    const taskId = `task_${randomUUID()}`;
    let task: TaskRecord;
    try {
      task = this.store.createTask({
        id: taskId,
        idempotencyKey: input.idempotencyKey ?? null,
        origin: input.origin,
        projectId: input.projectId,
        mode: input.mode,
        prompt,
        promptHash,
      });
      if (input.mode === 'execute') {
        this.projectWriteLocks.set(input.projectId, task.id);
      }
    } catch (error) {
      if (input.mode === 'execute' && this.projectWriteLocks.get(input.projectId) === 'pending') {
        this.projectWriteLocks.delete(input.projectId);
      }
      throw error;
    }

    this.store.appendAuditLog({
      origin: input.origin,
      actor: input.origin,
      action: 'task_submitted',
      projectId: input.projectId,
      taskId: task.id,
      detail: { mode: input.mode, idempotencyKey: input.idempotencyKey ?? null },
    });

    this.emitEvent(task.id, 'task_status', { status: task.status, mode: task.mode });
    this.broadcastSnapshot(task.id);

    void this.dispatchInitialTurn(task.id, project.rootPath, project.permissionMode, input.model);

    return {
      task,
      deduplicated: false,
      resumeCommand: null,
    };
  }

  followupTask(input: FollowupTaskInput): TaskRecord {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Follow-up prompt must not be empty');

    const task = this.store.getTask(input.taskId);
    if (!task) throw new Error(`Task not found: ${input.taskId}`);
    if (!task.threadId) {
      throw new Error(`Task "${task.id}" has no Codex threadId yet`);
    }
    if (task.status === 'QUEUED' || task.status === 'RUNNING' || task.status === 'WAITING_APPROVAL') {
      throw new Error(`Task "${task.id}" is currently ${task.status}; wait or interrupt first`);
    }
    if (task.turnCount >= this.config.guardrails.maxFollowupTurns) {
      throw new Error(
        `Task "${task.id}" reached maxFollowupTurns (${this.config.guardrails.maxFollowupTurns})`
      );
    }
    if (task.consecutiveErrors >= this.config.guardrails.maxConsecutiveErrors) {
      throw new Error(
        `Circuit breaker tripped for task "${task.id}" after ${task.consecutiveErrors} consecutive errors`
      );
    }

    const mode = input.mode ?? task.mode;
    const project = this.sandbox.getProject(task.projectId);
    if (mode === 'execute' && project.permissionMode !== 'codex_work') {
      throw new Error(
        `Project "${project.id}" has permissionMode="${project.permissionMode}", which forbids execute mode`
      );
    }

    if (mode === 'execute') {
      this.acquireWriteLock(task.projectId, task.id);
    }

    const updated = this.store.updateTask(task.id, {
      status: 'RUNNING',
      activeTurnId: null,
      lastError: null,
      structuredReport: null,
      finalMessage: null,
      completedAt: null,
    });
    this.threadToTaskId.set(task.threadId, task.id);
    this.agentTextBuffers.delete(task.id);
    this.runtimeStates.set(task.id, {
      phase: 'thinking',
      turnStartedAt: Date.now(),
      activeCommand: null,
      activeCommandStartedAt: null,
      lastCommand: null,
      latestInterimText: null,
      softTimeoutTriggered: false,
    });

    this.store.appendAuditLog({
      origin: input.origin,
      actor: input.origin,
      action: 'task_followup',
      projectId: task.projectId,
      taskId: task.id,
      detail: { mode, turnCount: task.turnCount },
    });

    this.emitEvent(task.id, 'task_status', { status: 'RUNNING', followup: true, mode });
    this.broadcastSnapshot(task.id);

    void this.dispatchFollowupTurn(task.id, task.threadId, project.rootPath, mode, prompt, input.model);
    return updated;
  }

  async waitTask(taskId: string, timeoutMs = 12_000, afterSeq = 0): Promise<WaitTaskResult> {
    const clamped = Math.max(500, Math.min(15_000, Math.floor(timeoutMs)));
    const normalizedAfterSeq = Math.max(0, Math.floor(afterSeq));
    const existing = this.store.getTask(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);

    if (!WAIT_STOP_STATUSES.has(existing.status)) {
      await new Promise<void>((resolveWait) => {
        let timer: NodeJS.Timeout | undefined;
        const wake = () => {
          const current = this.store.getTask(taskId);
          if (!current || WAIT_STOP_STATUSES.has(current.status)) {
            cleanup();
            resolveWait();
          }
        };
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          const set = this.waiters.get(taskId);
          if (set) {
            set.delete(wake);
            if (set.size === 0) this.waiters.delete(taskId);
          }
        };
        let set = this.waiters.get(taskId);
        if (!set) {
          set = new Set();
          this.waiters.set(taskId, set);
        }
        set.add(wake);
        timer = setTimeout(() => {
          cleanup();
          resolveWait();
        }, clamped);
        // Re-check immediately in case status transitioned before subscription
        wake();
      });
    }

    const latest = this.store.getTask(taskId);
    if (!latest) throw new Error(`Task not found: ${taskId}`);
    const newEvents = this.listEventsPaged(taskId, normalizedAfterSeq, 5000);
    const lastSeq =
      newEvents.length > 0
        ? newEvents[newEvents.length - 1].seq
        : Math.max(normalizedAfterSeq, this.getLatestSeq(taskId));
    return {
      task: latest,
      approvals: this.store.listApprovalsForTask(taskId),
      recentEvents: newEvents.slice(-20),
      compactedEvents: compactEventsForWait(newEvents, 15),
      lastSeq,
      progress: this.getTaskProgress(latest),
      contextUsage: computeContextUsage(latest.tokenUsageJson),
      resumeCommand: formatResumeCommand(latest.threadId),
      timedOut: !WAIT_STOP_STATUSES.has(latest.status),
    };
  }

  async interruptTask(taskId: string, actor: string, origin: ClientOrigin = 'system'): Promise<TaskRecord> {
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new Error(`Task "${taskId}" is already ${task.status}`);
    }

    this.flushTaskDeltas(taskId);
    this.clearTurnTimer(taskId);

    const pendingApprovals = this.store
      .listApprovalsForTask(taskId)
      .filter((a) => a.status === 'PENDING');
    for (const approval of pendingApprovals) {
      this.adapter.rejectApprovalIfPending(approval.id, approval.rpcRequestId, 'Task interrupted');
    }
    this.store.cancelPendingApprovalsForTask(taskId);

    if (task.threadId && task.activeTurnId && this.adapter.isRunning()) {
      try {
        await this.adapter.interruptTurn(task.threadId, task.activeTurnId);
      } catch {
        // Best-effort turn interrupt if app-server is shutting down or already done
      }
    }

    const updated = this.store.updateTask(taskId, {
      status: 'CANCELLED',
      activeTurnId: null,
      completedAt: Date.now(),
    });
    const rt = this.runtimeStates.get(taskId);
    if (rt) {
      rt.phase = 'cancelled';
      rt.activeCommand = null;
      rt.activeCommandStartedAt = null;
    }
    this.releaseWriteLock(task.projectId, task.id);

    this.store.appendAuditLog({
      origin,
      actor,
      action: 'task_interrupted',
      projectId: task.projectId,
      taskId: task.id,
      detail: { previousStatus: task.status },
    });

    this.emitEvent(taskId, 'task_status', { status: 'CANCELLED', reason: `Interrupted by ${actor}` });
    this.broadcastSnapshot(taskId);
    this.notifyWaiters(taskId);
    return updated;
  }

  decideApproval(approvalId: string, decision: ApprovalDecision, decidedBy: string): ApprovalRecord {
    const existing = this.store.getApproval(approvalId);
    if (!existing) throw new Error(`Approval not found: ${approvalId}`);
    if (existing.status !== 'PENDING') {
      throw new Error(`Approval "${approvalId}" is no longer PENDING (status=${existing.status})`);
    }

    const resolved = this.store.resolveApproval({
      id: approvalId,
      decision,
      decidedBy,
    });
    this.adapter.replyApproval(resolved, decision);

    const task = this.store.getTask(resolved.taskId);
    if (task) {
      this.flushTaskDeltas(task.id);
      this.emitEvent(task.id, 'approval_resolved', {
        approvalId: resolved.id,
        decision: resolved.decision,
        decidedBy,
        summary: resolved.summary,
      });

      const stillPending = this.store
        .listApprovalsForTask(task.id)
        .some((a) => a.status === 'PENDING');
      if (!stillPending && task.status === 'WAITING_APPROVAL') {
        this.store.updateTask(task.id, { status: 'RUNNING' });
        this.resetTurnTimer(task.id);
        this.emitEvent(task.id, 'task_status', { status: 'RUNNING' });
      }

      this.store.appendAuditLog({
        origin: 'system',
        actor: decidedBy,
        action: 'approval_decided',
        projectId: task.projectId,
        taskId: task.id,
        detail: { approvalId: resolved.id, decision },
      });

      this.broadcastApprovalUpdate(task.id, resolved);
      this.broadcastSnapshot(task.id);
      this.notifyWaiters(task.id);
    }

    return resolved;
  }

  async shutdown(): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;

    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
    for (const timer of this.softTurnTimers.values()) clearTimeout(timer);
    this.softTurnTimers.clear();

    for (const key of [...this.deltaBuffers.keys()]) {
      this.flushDeltaBuffer(key);
    }

    const pending = this.store.listPendingApprovals();
    for (const approval of pending) {
      this.adapter.rejectApprovalIfPending(approval.id, approval.rpcRequestId, 'Hub shutting down');
      this.store.cancelPendingApprovalsForTask(approval.taskId);
    }

    for (const unsub of this.unsubs) unsub();
    this.unsubs.length = 0;

    await this.adapter.stop();
    this.store.close();
  }

  private acquireWriteLock(projectId: string, candidateTaskId: string): void {
    const holderId = this.projectWriteLocks.get(projectId);
    if (holderId && holderId !== candidateTaskId) {
      if (holderId === 'pending') {
        throw new Error(`Project "${projectId}" is currently acquiring an execute lock`);
      }
      const holder = this.store.getTask(holderId);
      if (holder && !TERMINAL_STATUSES.has(holder.status)) {
        throw new Error(
          `Project "${projectId}" already has an active execute task (${holder.id}, status=${holder.status})`
        );
      }
      this.projectWriteLocks.delete(projectId);
    }

    // Double-check persisted state in case of previous unclean exit
    for (const activeStatus of ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'] as const) {
      const active = this.store.listTasks({ projectId, status: activeStatus, limit: 50 });
      const conflicting = active.find((t) => t.mode === 'execute' && t.id !== candidateTaskId);
      if (conflicting) {
        this.projectWriteLocks.set(projectId, conflicting.id);
        throw new Error(
          `Project "${projectId}" already has an active execute task (${conflicting.id}, status=${conflicting.status})`
        );
      }
    }

    this.projectWriteLocks.set(projectId, candidateTaskId);
  }

  private releaseWriteLock(projectId: string, taskId: string): void {
    if (this.projectWriteLocks.get(projectId) === taskId) {
      this.projectWriteLocks.delete(projectId);
    }
  }

  private async dispatchInitialTurn(
    taskId: string,
    cwd: string,
    permissionMode: 'read_only' | 'docs_write' | 'codex_work',
    model?: string
  ): Promise<void> {
    const initial = this.store.getTask(taskId);
    if (!initial || initial.status === 'CANCELLED') return;

    try {
      await this.ensureStarted();
      const current = this.store.getTask(taskId);
      if (!current || current.status === 'CANCELLED') return;

      const { threadId } = await this.adapter.startThread({
        cwd,
        mode: current.mode,
        permissionMode,
        model,
      });

      this.threadToTaskId.set(threadId, taskId);
      const runningTask = this.store.updateTask(taskId, {
        status: 'RUNNING',
        threadId,
      });
      this.runtimeStates.set(taskId, {
        phase: 'thinking',
        turnStartedAt: Date.now(),
        activeCommand: null,
        activeCommandStartedAt: null,
        lastCommand: null,
        latestInterimText: null,
        softTimeoutTriggered: false,
      });
      this.emitEvent(taskId, 'thread_started', { threadId });
      this.emitEvent(taskId, 'task_status', { status: 'RUNNING' });
      this.broadcastSnapshot(taskId);

      await this.startAndRecordTurn(runningTask, threadId, cwd, runningTask.mode, runningTask.prompt, model);
    } catch (error) {
      this.failTaskFromDispatch(taskId, error);
    }
  }

  private async dispatchFollowupTurn(
    taskId: string,
    threadId: string,
    cwd: string,
    mode: TaskMode,
    prompt: string,
    model?: string
  ): Promise<void> {
    try {
      await this.ensureStarted();
      const current = this.store.getTask(taskId);
      if (!current || current.status === 'CANCELLED') return;

      try {
        await this.adapter.resumeThread(threadId, cwd);
      } catch {
        // Thread may already be loaded in the active app-server process
      }
      await this.startAndRecordTurn(current, threadId, cwd, mode, prompt, model);
    } catch (error) {
      this.failTaskFromDispatch(taskId, error);
    }
  }

  private async startAndRecordTurn(
    task: TaskRecord,
    threadId: string,
    cwd: string,
    mode: TaskMode,
    prompt: string,
    model?: string
  ): Promise<void> {
    this.resetTurnTimer(task.id);
    const { turnId } = await this.adapter.startTurn({
      threadId,
      prompt,
      mode,
      cwd,
      model,
      useStructuredOutput: true,
    });
    const latest = this.store.getTask(task.id);
    if (!latest || TERMINAL_STATUSES.has(latest.status)) return;

    this.store.updateTask(task.id, {
      activeTurnId: turnId,
      turnCount: latest.turnCount + 1,
    });
    this.emitEvent(task.id, 'turn_started', { threadId, turnId }, turnId);
    this.broadcastSnapshot(task.id);
  }

  private failTaskFromDispatch(taskId: string, error: unknown): void {
    const task = this.store.getTask(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;
    this.clearTurnTimer(taskId);
    const message = error instanceof Error ? error.message : String(error);
    const consecutiveErrors = task.consecutiveErrors + 1;
    this.store.updateTask(taskId, {
      status: 'FAILED',
      activeTurnId: null,
      consecutiveErrors,
      lastError: message,
      completedAt: Date.now(),
    });
    const rt = this.runtimeStates.get(taskId);
    if (rt) {
      rt.phase = 'failed';
      rt.activeCommand = null;
      rt.activeCommandStartedAt = null;
    }
    this.releaseWriteLock(task.projectId, task.id);
    this.emitEvent(taskId, 'error', { message });
    this.emitEvent(taskId, 'task_status', { status: 'FAILED', error: message });
    this.broadcastSnapshot(taskId);
    this.notifyWaiters(taskId);
  }

  private handleCodexEvent(event: NormalizedCodexEvent): void {
    if (!event.threadId) return;
    const taskId = this.threadToTaskId.get(event.threadId);
    if (!taskId) return;
    const task = this.store.getTask(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;

    const ensureRuntime = (): TurnRuntimeState => {
      let rt = this.runtimeStates.get(taskId);
      if (!rt) {
        rt = {
          phase: 'thinking',
          turnStartedAt: task.updatedAt || Date.now(),
          activeCommand: null,
          activeCommandStartedAt: null,
          lastCommand: null,
          latestInterimText: null,
          softTimeoutTriggered: false,
        };
        this.runtimeStates.set(taskId, rt);
      }
      return rt;
    };

    switch (event.kind) {
      case 'thread_started':
      case 'turn_started':
        // Recorded cleanly by dispatch; ignore duplicate notifications
        break;
      case 'plan_updated':
        this.flushTaskDeltas(taskId);
        this.emitEvent(
          taskId,
          'plan_updated',
          { explanation: event.explanation, plan: event.plan },
          event.turnId
        );
        break;
      case 'reasoning_summary': {
        const rt = ensureRuntime();
        if (rt.phase !== 'waiting_approval' && rt.phase !== 'running_command') {
          rt.phase = 'thinking';
        }
        if (!this.agentTextBuffers.has(taskId) && event.delta.trim()) {
          rt.latestInterimText = tailSingleLine(event.delta, 400);
        }
        this.queueDelta(taskId, 'reasoning_summary', event.turnId, event.itemId, event.delta);
        break;
      }
      case 'command_started': {
        this.flushTaskDeltas(taskId);
        const rt = ensureRuntime();
        rt.phase = 'running_command';
        rt.activeCommand = extractCommandString(event.item);
        rt.activeCommandStartedAt = Date.now();
        this.emitEvent(taskId, 'command_started', { item: event.item }, event.turnId, event.itemId);
        break;
      }
      case 'command_output': {
        const itemKey = `${taskId}|${event.itemId ?? 'default'}`;
        if (this.commandTruncated.has(itemKey)) break;
        const prevBytes = this.commandByteCounts.get(itemKey) ?? 0;
        const chunkBytes = Buffer.byteLength(event.delta, 'utf8');
        const cap = this.config.guardrails.maxCommandOutputBytes;
        if (prevBytes + chunkBytes > cap) {
          const remaining = Math.max(0, cap - prevBytes);
          const prefix = Buffer.from(event.delta, 'utf8').subarray(0, remaining).toString('utf8');
          this.commandByteCounts.set(itemKey, cap);
          this.commandTruncated.add(itemKey);
          this.queueDelta(
            taskId,
            'command_output',
            event.turnId,
            event.itemId,
            `${prefix}\n[output truncated at ${cap} bytes]\n`
          );
        } else {
          this.commandByteCounts.set(itemKey, prevBytes + chunkBytes);
          this.queueDelta(taskId, 'command_output', event.turnId, event.itemId, event.delta);
        }
        break;
      }
      case 'command_completed': {
        this.flushTaskDeltas(taskId);
        const rt = ensureRuntime();
        const cmd = extractCommandString(event.item);
        const exitCode = typeof event.item.exitCode === 'number' ? event.item.exitCode : null;
        const durationMs =
          typeof event.item.durationMs === 'number'
            ? event.item.durationMs
            : rt.activeCommandStartedAt !== null
              ? Math.max(0, Date.now() - rt.activeCommandStartedAt)
              : null;
        rt.lastCommand = { command: cmd, exitCode, durationMs };
        rt.activeCommand = null;
        rt.activeCommandStartedAt = null;
        rt.phase = 'thinking';
        this.emitEvent(taskId, 'command_completed', { item: event.item }, event.turnId, event.itemId);
        break;
      }
      case 'file_change_updated': {
        this.flushTaskDeltas(taskId);
        const rt = ensureRuntime();
        rt.phase = 'editing_files';
        this.emitEvent(
          taskId,
          'file_change_updated',
          { changes: event.changes, status: event.status ?? null },
          event.turnId,
          event.itemId
        );
        break;
      }
      case 'diff_updated': {
        this.flushTaskDeltas(taskId);
        const rt = ensureRuntime();
        rt.phase = 'editing_files';
        this.store.updateTask(taskId, { latestDiff: event.diff });
        this.emitEvent(taskId, 'diff_updated', { diff: event.diff }, event.turnId);
        break;
      }
      case 'agent_message_delta': {
        const nextText = (this.agentTextBuffers.get(taskId) ?? '') + event.delta;
        this.agentTextBuffers.set(taskId, nextText);
        const rt = ensureRuntime();
        rt.phase = 'writing_response';
        if (nextText.trim()) {
          rt.latestInterimText = tailSingleLine(nextText, 400);
        }
        this.queueDelta(taskId, 'agent_message_delta', event.turnId, event.itemId, event.delta);
        break;
      }
      case 'agent_message': {
        this.flushTaskDeltas(taskId);
        this.agentTextBuffers.set(taskId, event.text);
        const rt = ensureRuntime();
        rt.phase = 'writing_response';
        if (event.text.trim()) {
          rt.latestInterimText = tailSingleLine(event.text, 400);
        }
        this.emitEvent(taskId, 'agent_message', { text: event.text }, event.turnId, event.itemId);
        break;
      }
      case 'token_usage':
        this.store.updateTask(taskId, { tokenUsageJson: JSON.stringify(event.tokenUsage) });
        this.emitEvent(taskId, 'token_usage', { tokenUsage: event.tokenUsage }, event.turnId);
        break;
      case 'warning':
        this.flushTaskDeltas(taskId);
        this.emitEvent(taskId, 'warning', { message: event.message });
        break;
      case 'error':
        this.flushTaskDeltas(taskId);
        this.emitEvent(taskId, 'error', { message: event.message }, event.turnId);
        break;
      case 'turn_completed':
        this.handleTurnCompleted(taskId, event);
        break;
    }
  }

  private handleTurnCompleted(
    taskId: string,
    event: Extract<NormalizedCodexEvent, { kind: 'turn_completed' }>
  ): void {
    this.flushTaskDeltas(taskId);
    this.clearTurnTimer(taskId);

    const task = this.store.getTask(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;

    // Cancel any leftover approvals if turn ended unexpectedly
    const leftover = this.store
      .listApprovalsForTask(taskId)
      .filter((a) => a.status === 'PENDING');
    for (const a of leftover) {
      this.adapter.rejectApprovalIfPending(a.id, a.rpcRequestId, 'Turn completed');
    }
    this.store.cancelPendingApprovalsForTask(taskId);

    const finalMessage =
      this.agentTextBuffers.get(taskId) ?? extractTextFromTurnItems(event.turn) ?? null;
    this.agentTextBuffers.delete(taskId);

    const structuredReport: CodexStructuredReport | null = tryParseStructuredReport(finalMessage);
    const turnFailed = event.status === 'failed' || Boolean(event.error);
    const turnInterrupted = event.status === 'interrupted';

    let nextStatus: TaskStatus = 'COMPLETED';
    let consecutiveErrors = 0;
    let lastError: string | null = null;

    if (turnInterrupted) {
      nextStatus = 'CANCELLED';
      consecutiveErrors = task.consecutiveErrors;
    } else if (turnFailed) {
      nextStatus = 'FAILED';
      consecutiveErrors = task.consecutiveErrors + 1;
      lastError = event.error ?? `Turn ended with status "${event.status}"`;
      if (consecutiveErrors >= this.config.guardrails.maxConsecutiveErrors) {
        lastError = `${lastError} (circuit breaker reached ${consecutiveErrors} consecutive errors)`;
      }
    }

    const rt = this.runtimeStates.get(taskId);
    if (rt) {
      rt.phase =
        nextStatus === 'COMPLETED'
          ? 'completed'
          : nextStatus === 'CANCELLED'
            ? 'cancelled'
            : 'failed';
      rt.activeCommand = null;
      rt.activeCommandStartedAt = null;
    }

    this.store.updateTask(taskId, {
      status: nextStatus,
      activeTurnId: null,
      consecutiveErrors,
      lastError,
      structuredReport,
      finalMessage: finalMessage ?? null,
      completedAt: Date.now(),
    });
    this.releaseWriteLock(task.projectId, task.id);

    this.emitEvent(
      taskId,
      'turn_completed',
      {
        status: event.status,
        error: lastError,
        verdict: structuredReport?.verdict ?? null,
      },
      event.turnId
    );
    this.emitEvent(taskId, 'task_status', { status: nextStatus, error: lastError }, event.turnId);
    this.broadcastSnapshot(taskId);
    this.notifyWaiters(taskId);
  }

  private handleApprovalRequest(req: NormalizedApprovalRequest): void {
    const taskId = this.threadToTaskId.get(req.threadId);
    if (!taskId) {
      this.adapter.rejectApprovalIfPending('unknown', String(req.rpcRequestId), 'Unknown thread');
      return;
    }
    const task = this.store.getTask(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) {
      this.adapter.rejectApprovalIfPending('unknown', String(req.rpcRequestId), 'Task not active');
      return;
    }

    this.flushTaskDeltas(taskId);
    this.clearTurnTimer(taskId);

    const approvalId = `appr_${randomUUID()}`;
    this.adapter.trackApprovalRpcId(approvalId, req.rpcRequestId);
    const approval = this.store.createApproval({
      id: approvalId,
      taskId,
      rpcRequestId: String(req.rpcRequestId),
      kind: req.kind,
      summary: req.summary,
      command: req.command,
      cwd: req.cwd,
      reason: req.reason,
      rawParams: req.rawParams,
    });

    if (task.status !== 'WAITING_APPROVAL') {
      this.store.updateTask(taskId, { status: 'WAITING_APPROVAL' });
      this.emitEvent(taskId, 'task_status', { status: 'WAITING_APPROVAL', approvalId: approval.id }, req.turnId);
    }
    const rt = this.runtimeStates.get(taskId);
    if (rt) {
      rt.phase = 'waiting_approval';
      if (req.command) rt.activeCommand = truncateSingleLine(req.command, 140);
    }

    this.emitEvent(
      taskId,
      'approval_requested',
      {
        approvalId: approval.id,
        kind: approval.kind,
        summary: approval.summary,
        command: approval.command,
        cwd: approval.cwd,
        reason: approval.reason,
      },
      req.turnId
    );
    this.broadcastApprovalUpdate(taskId, approval);
    this.broadcastSnapshot(taskId);
    this.notifyWaiters(taskId);
  }

  private handleAdapterExit(info: { code: number | null; signal: string | null }): void {
    if (this.shutDown) return;
    const message = `codex app-server exited unexpectedly (code=${info.code}, signal=${info.signal})`;
    for (const status of ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'] as const) {
      const activeTasks = this.store.listTasks({ status, limit: 200 });
      for (const task of activeTasks) {
        this.flushTaskDeltas(task.id);
        this.clearTurnTimer(task.id);
        this.store.cancelPendingApprovalsForTask(task.id);
        this.store.updateTask(task.id, {
          status: 'FAILED',
          activeTurnId: null,
          consecutiveErrors: task.consecutiveErrors + 1,
          lastError: message,
          completedAt: Date.now(),
        });
        this.releaseWriteLock(task.projectId, task.id);
        this.emitEvent(task.id, 'error', { message });
        this.emitEvent(task.id, 'task_status', { status: 'FAILED', error: message });
        this.broadcastSnapshot(task.id);
        this.notifyWaiters(task.id);
      }
    }
  }

  private queueDelta(
    taskId: string,
    type: DeltaBuffer['type'],
    turnId: string | null,
    itemId: string | null,
    delta: string
  ): void {
    const key = `${taskId}|${type}|${turnId ?? ''}|${itemId ?? ''}`;
    const existing = this.deltaBuffers.get(key);
    if (existing) {
      existing.chunks.push(delta);
      return;
    }
    const timer = setTimeout(() => {
      this.flushDeltaBuffer(key);
    }, this.config.guardrails.deltaFlushIntervalMs);
    this.deltaBuffers.set(key, {
      key,
      taskId,
      type,
      turnId,
      itemId,
      chunks: [delta],
      timer,
    });
  }

  private flushTaskDeltas(taskId: string): void {
    for (const [key, buf] of this.deltaBuffers.entries()) {
      if (buf.taskId === taskId) {
        this.flushDeltaBuffer(key);
      }
    }
  }

  private flushDeltaBuffer(key: string): void {
    const buf = this.deltaBuffers.get(key);
    if (!buf) return;
    clearTimeout(buf.timer);
    this.deltaBuffers.delete(key);
    const combined = buf.chunks.join('');
    if (!combined) return;
    this.emitEvent(buf.taskId, buf.type, { delta: combined }, buf.turnId, buf.itemId);
  }

  private resetTurnTimer(taskId: string): void {
    this.clearTurnTimer(taskId);
    const maxMs = this.config.guardrails.maxTaskDurationMs;
    const softDelay = Math.floor(maxMs * 0.82);
    if (softDelay >= 200 && softDelay < maxMs) {
      const softTimer = setTimeout(() => {
        void this.handleSoftTurnTimeout(taskId);
      }, softDelay);
      this.softTurnTimers.set(taskId, softTimer);
    }
    const timer = setTimeout(() => {
      void this.handleTurnTimeout(taskId);
    }, maxMs);
    this.turnTimers.set(taskId, timer);
  }

  private clearTurnTimer(taskId: string): void {
    const timer = this.turnTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.turnTimers.delete(taskId);
    }
    const softTimer = this.softTurnTimers.get(taskId);
    if (softTimer) {
      clearTimeout(softTimer);
      this.softTurnTimers.delete(taskId);
    }
  }

  private async handleSoftTurnTimeout(taskId: string): Promise<void> {
    this.softTurnTimers.delete(taskId);
    const task = this.store.getTask(taskId);
    if (!task || task.status !== 'RUNNING') return;

    const rt = this.runtimeStates.get(taskId);
    if (rt) rt.softTimeoutTriggered = true;

    this.emitEvent(
      taskId,
      'warning',
      {
        message: `Soft timeout reached (~82% of ${this.config.guardrails.maxTaskDurationMs}ms); asking Codex to wrap up current findings.`,
      },
      task.activeTurnId
    );
    this.broadcastSnapshot(taskId);

    if (task.threadId && task.activeTurnId && this.adapter.isRunning()) {
      try {
        await this.adapter.steerTurn(
          task.threadId,
          task.activeTurnId,
          'TIME LIMIT WARNING: You are approaching the turn timeout. Do not start new long commands or scans. Immediately summarize all verified findings so far and emit your final structured JSON report.'
        );
      } catch {
        // Best-effort soft wrap-up steer
      }
    }
  }

  private async handleTurnTimeout(taskId: string): Promise<void> {
    this.turnTimers.delete(taskId);
    const softTimer = this.softTurnTimers.get(taskId);
    if (softTimer) {
      clearTimeout(softTimer);
      this.softTurnTimers.delete(taskId);
    }
    const task = this.store.getTask(taskId);
    if (!task || TERMINAL_STATUSES.has(task.status)) return;

    this.flushTaskDeltas(taskId);
    this.store.cancelPendingApprovalsForTask(taskId);

    if (task.threadId && task.activeTurnId && this.adapter.isRunning()) {
      try {
        await this.adapter.interruptTurn(task.threadId, task.activeTurnId);
      } catch {
        // ignore
      }
    }

    const rt = this.runtimeStates.get(taskId);
    const buffered = (this.agentTextBuffers.get(taskId) ?? rt?.latestInterimText ?? '').trim();
    this.agentTextBuffers.delete(taskId);
    const partialReport = buffered ? tryParseStructuredReport(buffered) : null;
    const preservedMessage = buffered
      ? `[Partial output preserved before timeout]\n${buffered}`
      : rt?.activeCommand
        ? `[Timed out while running command: ${rt.activeCommand}]`
        : rt?.lastCommand
          ? `[Timed out after last command: ${rt.lastCommand.command} (exit=${rt.lastCommand.exitCode})]`
          : null;

    if (rt) {
      rt.phase = 'failed';
      rt.activeCommand = null;
      rt.activeCommandStartedAt = null;
    }

    const message = `Task timed out after ${this.config.guardrails.maxTaskDurationMs}ms`;
    this.store.updateTask(taskId, {
      status: 'FAILED',
      activeTurnId: null,
      consecutiveErrors: task.consecutiveErrors + 1,
      lastError: message,
      structuredReport: partialReport,
      finalMessage: preservedMessage,
      completedAt: Date.now(),
    });
    this.releaseWriteLock(task.projectId, task.id);

    this.emitEvent(taskId, 'error', { message });
    this.emitEvent(taskId, 'task_status', { status: 'FAILED', error: message });
    this.broadcastSnapshot(taskId);
    this.notifyWaiters(taskId);
  }

  private emitEvent(
    taskId: string,
    type: TaskEventType,
    payload: Record<string, unknown>,
    turnId: string | null = null,
    itemId: string | null = null
  ): TaskEventRecord {
    const record = this.store.appendEvent({
      taskId,
      type,
      turnId,
      itemId,
      payload,
    });
    this.lastTaskSeq.set(taskId, record.seq);
    const listeners = this.streamListeners.get(taskId);
    if (listeners) {
      for (const fn of listeners) fn({ kind: 'task_event', data: record });
    }
    return record;
  }

  private broadcastSnapshot(taskId: string): void {
    const listeners = this.streamListeners.get(taskId);
    if (!listeners || listeners.size === 0) return;
    const detail = this.getTaskDetail(taskId);
    if (!detail) return;
    for (const fn of listeners) fn({ kind: 'task_snapshot', data: detail });
  }

  private broadcastApprovalUpdate(taskId: string, approval: ApprovalRecord): void {
    const listeners = this.streamListeners.get(taskId);
    if (!listeners) return;
    for (const fn of listeners) fn({ kind: 'approval_update', data: approval });
  }

  private notifyWaiters(taskId: string): void {
    const set = this.waiters.get(taskId);
    if (!set) return;
    for (const wake of [...set]) wake();
  }
}
