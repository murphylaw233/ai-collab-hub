/**
 * Shared domain models, interfaces, and protocol constants for ai-collab-hub.
 * Locked contract file — delegated modules must implement against these types
 * without modifying this file.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

export type ClientOrigin = 'antigravity' | 'gemini_app' | 'system';

export type ProjectPermissionMode = 'read_only' | 'docs_write' | 'codex_work';

export interface ProjectConfig {
  id: string;
  name: string;
  rootPath: string;
  permissionMode: ProjectPermissionMode;
  docsSubdir: string;
  description?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  rootPath: string;
  permissionMode: ProjectPermissionMode;
  docsSubdir: string;
  description?: string;
}

export type CodexTransportMode = 'stdio' | 'ws';

export interface CodexRuntimeConfig {
  binPath?: string;
  transport: CodexTransportMode;
  wsPort: number;
  defaultModel?: string;
  defaultApprovalPolicy: 'on-request' | 'untrusted' | 'never';
  defaultSandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  ephemeralThreads: boolean;
}

export interface GuardrailConfig {
  idempotencyCooldownMs: number;
  maxTaskDurationMs: number;
  maxFollowupTurns: number;
  maxConsecutiveErrors: number;
  maxCommandOutputBytes: number;
  deltaFlushIntervalMs: number;
}

export interface RemoteStaticClientConfig {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

export interface RemoteGatewayConfig {
  enabled: boolean;
  host: string;
  port: number;
  publicBaseUrl?: string;
  ownerPassphrase?: string;
  staticClient?: RemoteStaticClientConfig;
  allowedRedirectUriPrefixes: string[];
  accessTokenTtlSec: number;
  refreshTokenTtlSec: number;
  maxStateLength: number;
  allowRemoteDocsWrite: boolean;
}

export interface HubConfig {
  host: string;
  port: number;
  localToken: string;
  localTokenGenerated: boolean;
  configPath?: string;
  dbPath: string;
  projects: ProjectConfig[];
  codex: CodexRuntimeConfig;
  guardrails: GuardrailConfig;
  remote: RemoteGatewayConfig;
}

export type TaskMode = 'precheck' | 'readonly_research' | 'execute';

export type TaskStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type CodexVerdict = 'completed' | 'plan_concern' | 'blocked';

export interface CodexStructuredReport {
  verdict: CodexVerdict;
  summary: string;
  risks_or_disagreements: string[];
  changed_files: string[];
  verification_output: string;
  next_suggested_action: string | null;
}

export const CODEX_REPORT_OUTPUT_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: false,
  required: [
    'verdict',
    'summary',
    'risks_or_disagreements',
    'changed_files',
    'verification_output',
    'next_suggested_action',
  ],
  properties: {
    verdict: {
      type: 'string',
      enum: ['completed', 'plan_concern', 'blocked'],
    },
    summary: {
      type: 'string',
    },
    risks_or_disagreements: {
      type: 'array',
      items: { type: 'string' },
    },
    changed_files: {
      type: 'array',
      items: { type: 'string' },
    },
    verification_output: {
      type: 'string',
    },
    next_suggested_action: {
      type: ['string', 'null'],
    },
  },
} as const;

export interface TaskRecord {
  id: string;
  idempotencyKey: string | null;
  origin: ClientOrigin;
  projectId: string;
  mode: TaskMode;
  status: TaskStatus;
  prompt: string;
  promptHash: string;
  threadId: string | null;
  activeTurnId: string | null;
  turnCount: number;
  consecutiveErrors: number;
  lastError: string | null;
  structuredReport: CodexStructuredReport | null;
  finalMessage: string | null;
  latestDiff: string | null;
  tokenUsageJson: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface CreateTaskInput {
  id: string;
  idempotencyKey?: string | null;
  origin: ClientOrigin;
  projectId: string;
  mode: TaskMode;
  prompt: string;
  promptHash: string;
  threadId?: string | null;
}

export type TaskEventType =
  | 'task_status'
  | 'thread_started'
  | 'turn_started'
  | 'plan_updated'
  | 'reasoning_summary'
  | 'command_started'
  | 'command_output'
  | 'command_completed'
  | 'file_change_updated'
  | 'diff_updated'
  | 'agent_message_delta'
  | 'agent_message'
  | 'approval_requested'
  | 'approval_resolved'
  | 'warning'
  | 'error'
  | 'token_usage'
  | 'turn_completed';

export interface TaskEventRecord {
  id: number;
  taskId: string;
  seq: number;
  type: TaskEventType;
  turnId: string | null;
  itemId: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface AppendEventInput {
  taskId: string;
  type: TaskEventType;
  turnId?: string | null;
  itemId?: string | null;
  payload: Record<string, unknown>;
  createdAt?: number;
}

export type ApprovalKind = 'command' | 'file_change' | 'permissions' | 'user_input';

export type ApprovalStatus = 'PENDING' | 'DECIDED' | 'EXPIRED' | 'CANCELLED';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalRecord {
  id: string;
  taskId: string;
  rpcRequestId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  summary: string;
  command: string | null;
  cwd: string | null;
  reason: string | null;
  rawParams: Record<string, unknown>;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface CreateApprovalInput {
  id: string;
  taskId: string;
  rpcRequestId: string;
  kind: ApprovalKind;
  summary: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  rawParams: Record<string, unknown>;
}

export interface ResolveApprovalInput {
  id: string;
  decision: ApprovalDecision;
  decidedBy: string;
}

export interface AuditLogRecord {
  id: number;
  origin: ClientOrigin;
  actor: string;
  action: string;
  projectId: string | null;
  taskId: string | null;
  detail: Record<string, unknown>;
  createdAt: number;
}

export interface AppendAuditLogInput {
  origin: ClientOrigin;
  actor: string;
  action: string;
  projectId?: string | null;
  taskId?: string | null;
  detail: Record<string, unknown>;
}

export interface ListTasksFilter {
  status?: TaskStatus;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export interface ITaskStore {
  close(): void;
  createTask(input: CreateTaskInput): TaskRecord;
  getTask(taskId: string): TaskRecord | null;
  listTasks(filter?: ListTasksFilter): TaskRecord[];
  findRecentDuplicateTask(params: {
    idempotencyKey?: string | null;
    projectId: string;
    promptHash: string;
    threadId?: string | null;
    sinceMs: number;
  }): TaskRecord | null;
  updateTask(
    taskId: string,
    patch: Partial<
      Pick<
        TaskRecord,
        | 'status'
        | 'threadId'
        | 'activeTurnId'
        | 'turnCount'
        | 'consecutiveErrors'
        | 'lastError'
        | 'structuredReport'
        | 'finalMessage'
        | 'latestDiff'
        | 'tokenUsageJson'
        | 'completedAt'
      >
    >
  ): TaskRecord;

  appendEvent(input: AppendEventInput): TaskEventRecord;
  listEvents(taskId: string, afterSeq?: number, limit?: number): TaskEventRecord[];

  createApproval(input: CreateApprovalInput): ApprovalRecord;
  getApproval(approvalId: string): ApprovalRecord | null;
  listApprovalsForTask(taskId: string): ApprovalRecord[];
  listPendingApprovals(): ApprovalRecord[];
  resolveApproval(input: ResolveApprovalInput): ApprovalRecord;
  cancelPendingApprovalsForTask(taskId: string): number;

  appendAuditLog(input: AppendAuditLogInput): AuditLogRecord;
  listAuditLogs(limit?: number): AuditLogRecord[];
}

export interface DirEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  sizeBytes: number | null;
}

export interface DirListResult {
  projectId: string;
  relativePath: string;
  entries: DirEntry[];
  truncated: boolean;
}

export interface ReadLinesResult {
  projectId: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}

export interface SearchMatch {
  relativePath: string;
  line: number;
  preview: string;
}

export interface SearchFilesResult {
  projectId: string;
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export interface GitDiffResult {
  projectId: string;
  isGitRepo: boolean;
  branch: string | null;
  statusPorcelain: string;
  diff: string;
  truncated: boolean;
}

export interface WriteDocResult {
  projectId: string;
  relativePath: string;
  bytesWritten: number;
}

export interface IFileSandbox {
  listProjects(): ProjectSummary[];
  getProject(projectId: string): ProjectConfig;
  upsertProject(project: ProjectConfig): ProjectSummary;
  removeProject(projectId: string): boolean;
  resolveSafePath(projectId: string, relativePath?: string): Promise<string>;
  listDir(
    projectId: string,
    relativePath?: string,
    options?: { maxDepth?: number; maxEntries?: number }
  ): Promise<DirListResult>;
  readLines(
    projectId: string,
    relativePath: string,
    startLine?: number,
    endLine?: number,
    options?: { maxBytes?: number }
  ): Promise<ReadLinesResult>;
  searchFiles(
    projectId: string,
    query: string,
    options?: { relativePath?: string; maxMatches?: number; caseSensitive?: boolean }
  ): Promise<SearchFilesResult>;
  gitStatusAndDiff(
    projectId: string,
    options?: { maxDiffBytes?: number; includeUntracked?: boolean }
  ): Promise<GitDiffResult>;
  writeDoc(
    projectId: string,
    relativePath: string,
    content: string,
    options?: { overwrite?: boolean }
  ): Promise<WriteDocResult>;
}

export interface IncomingServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface InitializeResultSummary {
  userAgent: string | null;
  platformFamily: string | null;
  platformOs: string | null;
  raw: Record<string, unknown>;
}

export interface CodexTransportInfo {
  transport: CodexTransportMode;
  wsUrl: string | null;
  wsTokenEnvVar: string | null;
  wsToken: string | null;
}

export interface CodexRpcClientOptions {
  binPath?: string;
  cwd?: string;
  transport: CodexTransportMode;
  wsHost?: string;
  wsPort?: number;
  clientInfo?: {
    name: string;
    title: string;
    version: string;
  };
  requestTimeoutMs?: number;
}

export interface ICodexRpcClient {
  start(): Promise<InitializeResultSummary>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getTransportInfo(): CodexTransportInfo;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  respondToServerRequest(id: string | number, result: unknown): void;
  rejectServerRequest(id: string | number, code: number, message: string): void;
  onNotification(handler: (method: string, params: unknown) => void): () => void;
  onServerRequest(handler: (req: IncomingServerRequest) => void): () => void;
  onExit(handler: (info: { code: number | null; signal: string | null }) => void): () => void;
}

export type OAuthTokenEndpointAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  clientSecretHash: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
  isStatic: boolean;
  createdAt: number;
}

export interface OAuthAuthCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  resource: string | null;
  expiresAt: number;
  usedAt: number | null;
  createdAt: number;
}

export interface OAuthTokenRecord {
  id: string;
  clientId: string;
  scope: string;
  resource: string | null;
  accessTokenHash: string;
  refreshTokenHash: string | null;
  accessExpiresAt: number;
  refreshExpiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface IOAuthStore {
  close(): void;
  upsertClient(client: Omit<OAuthClientRecord, 'createdAt'>): OAuthClientRecord;
  getClient(clientId: string): OAuthClientRecord | null;
  createAuthCode(record: Omit<OAuthAuthCodeRecord, 'usedAt' | 'createdAt'>): OAuthAuthCodeRecord;
  consumeAuthCode(codeHash: string, nowMs?: number): OAuthAuthCodeRecord | null;
  createToken(record: Omit<OAuthTokenRecord, 'revokedAt' | 'createdAt'>): OAuthTokenRecord;
  getTokenByAccessHash(accessTokenHash: string): OAuthTokenRecord | null;
  getTokenByRefreshHash(refreshTokenHash: string): OAuthTokenRecord | null;
  rotateRefreshToken(params: {
    oldTokenId: string;
    newToken: Omit<OAuthTokenRecord, 'revokedAt' | 'createdAt'>;
  }): OAuthTokenRecord;
  revokeTokenByHash(tokenHash: string): boolean;
  revokeAllTokens(): number;
  countActiveTokens(nowMs?: number): number;
  purgeExpired(nowMs?: number): number;
}

export interface VerifiedAccessToken {
  tokenId: string;
  clientId: string;
  scope: string;
  resource: string | null;
  expiresAt: number;
}

export interface IOAuthServer {
  handleHttpRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  verifyAccessToken(authHeader: string | undefined): VerifiedAccessToken | null;
  buildWwwAuthenticateHeader(): string;
  revokeAllTokens(): number;
  countActiveTokens(): number;
  close(): void;
}
