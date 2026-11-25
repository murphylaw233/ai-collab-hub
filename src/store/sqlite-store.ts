import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type {
  AppendAuditLogInput,
  AppendEventInput,
  ApprovalRecord,
  AuditLogRecord,
  CodexStructuredReport,
  CreateApprovalInput,
  CreateTaskInput,
  ITaskStore,
  ListTasksFilter,
  ResolveApprovalInput,
  TaskEventRecord,
  TaskRecord,
} from '../types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT NOT NULL PRIMARY KEY,
    idempotency_key TEXT,
    origin TEXT NOT NULL,
    project_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    prompt TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    thread_id TEXT,
    active_turn_id TEXT,
    turn_count INTEGER NOT NULL DEFAULT 0,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    structured_report TEXT,
    final_message TEXT,
    latest_diff TEXT,
    token_usage_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS tasks_idempotency_key_idx ON tasks (idempotency_key);
  CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks (project_id);
  CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
  CREATE INDEX IF NOT EXISTS tasks_created_at_idx ON tasks (created_at);

  CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    turn_id TEXT,
    item_id TEXT,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (task_id, seq)
  );

  CREATE TABLE IF NOT EXISTS approvals (
    id TEXT NOT NULL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id),
    rpc_request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    summary TEXT NOT NULL,
    command TEXT,
    cwd TEXT,
    reason TEXT,
    raw_params_json TEXT NOT NULL,
    decision TEXT,
    decided_by TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS approvals_task_status_idx ON approvals (task_id, status);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    project_id TEXT,
    task_id TEXT,
    detail_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

const TASK_COLUMNS = `
  id, idempotency_key AS idempotencyKey, origin, project_id AS projectId,
  mode, status, prompt, prompt_hash AS promptHash, thread_id AS threadId,
  active_turn_id AS activeTurnId, turn_count AS turnCount,
  consecutive_errors AS consecutiveErrors, last_error AS lastError,
  structured_report AS structuredReport, final_message AS finalMessage,
  latest_diff AS latestDiff, token_usage_json AS tokenUsageJson,
  created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
`;

const EVENT_COLUMNS = `
  id, task_id AS taskId, seq, type, turn_id AS turnId, item_id AS itemId,
  payload_json AS payload, created_at AS createdAt
`;

const APPROVAL_COLUMNS = `
  id, task_id AS taskId, rpc_request_id AS rpcRequestId, kind, status, summary,
  command, cwd, reason, raw_params_json AS rawParams, decision,
  decided_by AS decidedBy, created_at AS createdAt, decided_at AS decidedAt
`;

const AUDIT_COLUMNS = `
  id, origin, actor, action, project_id AS projectId, task_id AS taskId,
  detail_json AS detail, created_at AS createdAt
`;

type Row = Record<string, SQLOutputValue>;
type TaskPatch = Parameters<ITaskStore['updateTask']>[1];
type DuplicateTaskQuery = Parameters<ITaskStore['findRecentDuplicateTask']>[0];

function readTask(row: Row): TaskRecord {
  const { structuredReport, ...task } = row as Omit<TaskRecord, 'structuredReport'> & {
    structuredReport: string | null;
  };
  return {
    ...task,
    structuredReport: structuredReport === null
      ? null
      : JSON.parse(structuredReport) as CodexStructuredReport,
  };
}

function readEvent(row: Row): TaskEventRecord {
  const { payload, ...event } = row as Omit<TaskEventRecord, 'payload'> & { payload: string };
  return { ...event, payload: JSON.parse(payload) as TaskEventRecord['payload'] };
}

function readApproval(row: Row): ApprovalRecord {
  const { rawParams, ...approval } = row as Omit<ApprovalRecord, 'rawParams'> & { rawParams: string };
  return { ...approval, rawParams: JSON.parse(rawParams) as ApprovalRecord['rawParams'] };
}

function readAuditLog(row: Row): AuditLogRecord {
  const { detail, ...auditLog } = row as Omit<AuditLogRecord, 'detail'> & { detail: string };
  return { ...auditLog, detail: JSON.parse(detail) as AuditLogRecord['detail'] };
}

/** Synchronous SQLite store for tasks, task events, approvals, and audit logs. */
export class SqliteTaskStore implements ITaskStore {
  private readonly db: DatabaseSync;

  /** Opens or creates the database and initializes the schema on this connection. */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Releases the SQLite connection. */
  close(): void {
    this.db.close();
  }

  /** Creates a queued task with fresh creation and update timestamps. */
  createTask(input: CreateTaskInput): TaskRecord {
    const now = Date.now();
    const row = this.db.prepare(`
      INSERT INTO tasks (
        id, idempotency_key, origin, project_id, mode, prompt, prompt_hash,
        thread_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${TASK_COLUMNS}
    `).get(
      input.id, input.idempotencyKey ?? null, input.origin, input.projectId, input.mode,
      input.prompt, input.promptHash, input.threadId ?? null, now, now,
    );
    return readTask(row!);
  }

  /** Returns the task with this ID, or null if it is missing. */
  getTask(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(taskId);
    return row ? readTask(row) : null;
  }

  /** Lists tasks newest first, with optional filters and pagination. */
  listTasks(filter: ListTasksFilter = {}): TaskRecord[] {
    const conditions: string[] = [];
    const values: SQLInputValue[] = [];
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      values.push(filter.status);
    }
    if (filter.projectId !== undefined) {
      conditions.push('project_id = ?');
      values.push(filter.projectId);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    return this.db.prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      ${where}
      ORDER BY created_at DESC, rowid DESC
      LIMIT ? OFFSET ?
    `).all(...values, filter.limit ?? -1, filter.offset ?? 0).map(readTask);
  }

  /**
   * Finds the newest eligible task at or after the given epoch-millisecond cutoff.
   * A nonempty idempotency key is authoritative. A null or omitted thread ID allows any thread.
   */
  findRecentDuplicateTask(params: DuplicateTaskQuery): TaskRecord | null {
    const { idempotencyKey, projectId, promptHash, threadId, sinceMs } = params;
    const conditions = ["status NOT IN ('FAILED', 'CANCELLED')", 'created_at >= ?'];
    const values: SQLInputValue[] = [sinceMs];
    if (idempotencyKey) {
      conditions.push('idempotency_key = ?');
      values.push(idempotencyKey);
    } else {
      conditions.push('project_id = ?', 'prompt_hash = ?');
      values.push(projectId, promptHash);
      if (threadId != null) {
        conditions.push('thread_id = ?');
        values.push(threadId);
      }
    }

    const row = this.db.prepare(`
      SELECT ${TASK_COLUMNS} FROM tasks
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1
    `).get(...values);
    return row ? readTask(row) : null;
  }

  /** Patches only defined fields, allowing null to clear nullable fields. */
  updateTask(taskId: string, patch: TaskPatch): TaskRecord {
    const fields: [string, SQLInputValue | undefined][] = [
      ['updated_at', Date.now()],
      ['status', patch.status],
      ['thread_id', patch.threadId],
      ['active_turn_id', patch.activeTurnId],
      ['turn_count', patch.turnCount],
      ['consecutive_errors', patch.consecutiveErrors],
      ['last_error', patch.lastError],
      ['structured_report', patch.structuredReport == null
        ? patch.structuredReport
        : JSON.stringify(patch.structuredReport)],
      ['final_message', patch.finalMessage],
      ['latest_diff', patch.latestDiff],
      ['token_usage_json', patch.tokenUsageJson],
      ['completed_at', patch.completedAt],
    ];
    const assignments: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [column, value] of fields) {
      if (value !== undefined) {
        assignments.push(column + ' = ?');
        values.push(value);
      }
    }

    const row = this.db.prepare(`
      UPDATE tasks SET ${assignments.join(', ')}
      WHERE id = ?
      RETURNING ${TASK_COLUMNS}
    `).get(...values, taskId);
    if (!row) throw new Error(`Task "${taskId}" not found`);
    return readTask(row);
  }

  /** Acquires the write lock before allocating the next per-task sequence number. */
  appendEvent(input: AppendEventInput): TaskEventRecord {
    const payload = JSON.stringify(input.payload);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        INSERT INTO task_events (task_id, seq, type, turn_id, item_id, payload_json, created_at)
        VALUES (
          ?,
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM task_events WHERE task_id = ?),
          ?, ?, ?, ?, ?
        )
        RETURNING ${EVENT_COLUMNS}
      `).get(
        input.taskId, input.taskId, input.type, input.turnId ?? null, input.itemId ?? null,
        payload, input.createdAt ?? Date.now(),
      );
      const event = readEvent(row!);
      this.db.exec('COMMIT');
      return event;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Returns events after the exclusive cursor in ascending sequence order. */
  listEvents(taskId: string, afterSeq = 0, limit = 500): TaskEventRecord[] {
    return this.db.prepare(`
      SELECT ${EVENT_COLUMNS} FROM task_events
      WHERE task_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(taskId, afterSeq, limit).map(readEvent);
  }

  /** Records a new pending approval for an existing task. */
  createApproval(input: CreateApprovalInput): ApprovalRecord {
    const row = this.db.prepare(`
      INSERT INTO approvals (
        id, task_id, rpc_request_id, kind, summary, command, cwd, reason,
        raw_params_json, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${APPROVAL_COLUMNS}
    `).get(
      input.id, input.taskId, input.rpcRequestId, input.kind, input.summary, input.command ?? null,
      input.cwd ?? null, input.reason ?? null, JSON.stringify(input.rawParams), Date.now(),
    );
    return readApproval(row!);
  }

  /** Returns the approval with this ID, or null if it is missing. */
  getApproval(approvalId: string): ApprovalRecord | null {
    const row = this.db.prepare(`
      SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?
    `).get(approvalId);
    return row ? readApproval(row) : null;
  }

  /** Lists all approvals for a task in creation order. */
  listApprovalsForTask(taskId: string): ApprovalRecord[] {
    return this.db.prepare(`
      SELECT ${APPROVAL_COLUMNS} FROM approvals
      WHERE task_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(taskId).map(readApproval);
  }

  /** Lists pending approvals across tasks, oldest first. */
  listPendingApprovals(): ApprovalRecord[] {
    return this.db.prepare(`
      SELECT ${APPROVAL_COLUMNS} FROM approvals
      WHERE status = 'PENDING'
      ORDER BY created_at ASC, rowid ASC
    `).all().map(readApproval);
  }

  /** Decides a pending approval in one conditional write, so it can only be resolved once. */
  resolveApproval(input: ResolveApprovalInput): ApprovalRecord {
    const row = this.db.prepare(`
      UPDATE approvals
      SET status = 'DECIDED', decision = ?, decided_by = ?, decided_at = ?
      WHERE id = ? AND status = 'PENDING'
      RETURNING ${APPROVAL_COLUMNS}
    `).get(input.decision, input.decidedBy, Date.now(), input.id);
    if (!row) throw new Error(`Approval "${input.id}" not found or no longer PENDING`);
    return readApproval(row);
  }

  /** Cancels all pending approvals for the task and returns the number changed. */
  cancelPendingApprovalsForTask(taskId: string): number {
    const result = this.db.prepare(`
      UPDATE approvals SET status = 'CANCELLED'
      WHERE task_id = ? AND status = 'PENDING'
    `).run(taskId);
    return Number(result.changes);
  }

  /** Appends an audit entry, with optional project and task references. */
  appendAuditLog(input: AppendAuditLogInput): AuditLogRecord {
    const row = this.db.prepare(`
      INSERT INTO audit_logs (origin, actor, action, project_id, task_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING ${AUDIT_COLUMNS}
    `).get(
      input.origin, input.actor, input.action, input.projectId ?? null, input.taskId ?? null,
      JSON.stringify(input.detail), Date.now(),
    );
    return readAuditLog(row!);
  }

  /** Lists audit entries newest first, using the ID to break timestamp ties. */
  listAuditLogs(limit = -1): AuditLogRecord[] {
    return this.db.prepare(`
      SELECT ${AUDIT_COLUMNS} FROM audit_logs
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit).map(readAuditLog);
  }
}

/** Opens a task store backed by a database file or by an isolated in-memory database. */
export function createSqliteTaskStore(dbPath: string): SqliteTaskStore {
  return new SqliteTaskStore(dbPath);
}

