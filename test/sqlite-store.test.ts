import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createSqliteTaskStore } from '../src/store/sqlite-store.js';
import type { CodexStructuredReport, CreateTaskInput } from '../src/types.js';

function memoryStore(t: TestContext) {
  const store = createSqliteTaskStore(':memory:');
  t.after(() => store.close());
  return store;
}

function taskInput(id: string, overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    id,
    origin: 'antigravity',
    projectId: 'project-a',
    mode: 'execute',
    prompt: 'Run the checks',
    promptHash: 'checks-hash',
    ...overrides,
  };
}

function approvalInput(id: string, taskId: string) {
  return {
    id,
    taskId,
    rpcRequestId: 'rpc-' + id,
    kind: 'command' as const,
    summary: 'Run checks',
    command: 'npm test',
    cwd: 'D:/project-a',
    reason: 'Verify the change',
    rawParams: { command: ['npm', 'test'], options: { timeout: 5000 } },
  };
}

test('creates a queued task and applies partial updates with a JSON report', (t) => {
  const store = memoryStore(t);
  const input = taskInput('task-a', { idempotencyKey: 'request-a', threadId: 'thread-a' });
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);

  assert.equal(store.getTask('missing'), null);
  assert.deepEqual(store.createTask(input), {
    ...input,
    status: 'QUEUED',
    activeTurnId: null,
    turnCount: 0,
    consecutiveErrors: 0,
    lastError: null,
    structuredReport: null,
    finalMessage: null,
    latestDiff: null,
    tokenUsageJson: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    completedAt: null,
  });

  const structuredReport = {
    verdict: 'completed',
    summary: 'Checks passed',
    risks_or_disagreements: [],
    changed_files: ['src/example.ts'],
    verification_output: 'All tests passed',
    next_suggested_action: null,
  } satisfies CodexStructuredReport;
  now = 2_000;
  const updated = store.updateTask(input.id, {
    status: 'COMPLETED',
    threadId: undefined,
    activeTurnId: 'turn-a',
    turnCount: 1,
    consecutiveErrors: 2,
    lastError: 'Previous retry',
    structuredReport,
    finalMessage: 'Done',
    latestDiff: '+example',
    tokenUsageJson: '{"total":120}',
    completedAt: 1_900,
  });
  assert.deepEqual(updated, {
    ...input,
    status: 'COMPLETED',
    activeTurnId: 'turn-a',
    turnCount: 1,
    consecutiveErrors: 2,
    lastError: 'Previous retry',
    structuredReport,
    finalMessage: 'Done',
    latestDiff: '+example',
    tokenUsageJson: '{"total":120}',
    createdAt: 1_000,
    updatedAt: 2_000,
    completedAt: 1_900,
  });
  assert.deepEqual(store.getTask(input.id), updated);

  now = 3_000;
  assert.deepEqual(store.updateTask(input.id, { threadId: null, structuredReport: null }), {
    ...updated, threadId: null, structuredReport: null, updatedAt: 3_000,
  });
  now = 4_000;
  assert.equal(store.updateTask(input.id, {}).updatedAt, 4_000);
  assert.throws(() => store.updateTask('missing', {}), /task.*missing.*not found/i);
});

test('filters and paginates tasks in newest-first order', (t) => {
  const store = memoryStore(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  store.createTask(taskInput('old'));
  now = 2_000;
  store.createTask(taskInput('other-project', { projectId: 'project-b' }));
  now = 3_000;
  store.createTask(taskInput('running'));
  store.updateTask('running', { status: 'RUNNING' });
  store.createTask(taskInput('new'));

  assert.deepEqual(store.listTasks().map(({ id }) => id), ['new', 'running', 'other-project', 'old']);
  assert.deepEqual(
    store.listTasks({ status: 'QUEUED' }).map(({ id }) => id),
    ['new', 'other-project', 'old'],
  );
  assert.deepEqual(
    store.listTasks({ projectId: 'project-a' }).map(({ id }) => id),
    ['new', 'running', 'old'],
  );
  assert.deepEqual(
    store.listTasks({ projectId: 'project-a', status: 'QUEUED', limit: 1, offset: 1 })
      .map(({ id }) => id),
    ['old'],
  );
  assert.deepEqual(store.listTasks({ offset: 3 }).map(({ id }) => id), ['old']);
  assert.deepEqual(store.listTasks({ limit: 0 }), []);
});

test('uses a nonempty idempotency key to find the newest eligible task', (t) => {
  const store = memoryStore(t);
  t.mock.method(Date, 'now', () => 2_000);
  store.createTask(taskInput('old', { idempotencyKey: 'request-a' }));
  const latest = store.createTask(taskInput('new', {
    idempotencyKey: 'request-a', projectId: 'project-b', promptHash: 'other-hash',
  }));
  store.createTask(taskInput('cancelled', { idempotencyKey: 'request-a' }));
  store.updateTask('cancelled', { status: 'CANCELLED' });
  const query = {
    idempotencyKey: 'request-a',
    projectId: 'project-a',
    promptHash: 'checks-hash',
    threadId: 'a-different-thread',
    sinceMs: 2_000,
  };

  assert.deepEqual(store.findRecentDuplicateTask(query), latest);
  assert.equal(store.findRecentDuplicateTask({ ...query, sinceMs: 2_001 }), null);
  assert.equal(store.findRecentDuplicateTask({
    ...query, idempotencyKey: 'missing', threadId: null,
  }), null);
});

test('checks project, prompt hash, optional thread and time for cooldown duplicates', (t) => {
  const store = memoryStore(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const query = { projectId: 'project-a', promptHash: 'checks-hash', sinceMs: 1_000 };
  store.createTask(taskInput('without-thread'));
  now = 1_500;
  store.createTask(taskInput('thread-a-task', { threadId: 'thread-a' }));
  now = 2_000;
  store.createTask(taskInput('thread-b-task', { threadId: 'thread-b' }));
  store.createTask(taskInput('wrong-project', { projectId: 'project-b' }));
  store.createTask(taskInput('wrong-hash', { promptHash: 'other-hash' }));

  assert.equal(store.findRecentDuplicateTask({ ...query, idempotencyKey: '' })?.id, 'thread-b-task');
  assert.equal(store.findRecentDuplicateTask({ ...query, threadId: null })?.id, 'thread-b-task');
  assert.equal(store.findRecentDuplicateTask({ ...query, threadId: 'thread-a' })?.id, 'thread-a-task');
  assert.equal(store.findRecentDuplicateTask({ ...query, threadId: 'missing' }), null);
  assert.equal(store.findRecentDuplicateTask({ ...query, sinceMs: 2_001 }), null);

  store.updateTask('thread-b-task', { status: 'FAILED' });
  store.updateTask('thread-a-task', { status: 'CANCELLED' });
  assert.equal(store.findRecentDuplicateTask(query)?.id, 'without-thread');
  assert.equal(store.findRecentDuplicateTask({ ...query, sinceMs: 1_001 }), null);
});

test('sequences events per task and lists them by cursor and limit', (t) => {
  const store = memoryStore(t);
  store.createTask(taskInput('task-a'));
  store.createTask(taskInput('task-b'));
  const first = store.appendEvent({
    taskId: 'task-a',
    type: 'command_output',
    turnId: 'turn-a',
    itemId: 'item-a',
    payload: { chunks: ['输出', 'ok'], stream: { stderr: false } },
    createdAt: 0,
  });
  assert.deepEqual(first, {
    id: 1,
    taskId: 'task-a',
    seq: 1,
    type: 'command_output',
    turnId: 'turn-a',
    itemId: 'item-a',
    payload: { chunks: ['输出', 'ok'], stream: { stderr: false } },
    createdAt: 0,
  });
  assert.equal(store.appendEvent({ taskId: 'task-b', type: 'warning', payload: {} }).seq, 1);

  const second = store.appendEvent({ taskId: 'task-a', type: 'warning', payload: {} });
  const third = store.appendEvent({ taskId: 'task-a', type: 'turn_completed', payload: {} });
  assert.deepEqual([second.seq, third.seq], [2, 3]);
  assert.equal(second.turnId, null);
  assert.equal(second.itemId, null);
  assert.deepEqual(store.listEvents('task-a'), [first, second, third]);
  assert.deepEqual(store.listEvents('task-a', 1, 1), [second]);
  assert.deepEqual(store.listEvents('task-a', 3), []);
  assert.deepEqual(store.listEvents('missing'), []);
});

test('rolls back an event append that violates the task foreign key', (t) => {
  const store = memoryStore(t);
  const event = { taskId: 'task-a', type: 'warning' as const, payload: {} };

  assert.throws(() => store.appendEvent(event), /foreign key/i);
  store.createTask(taskInput('task-a'));
  assert.equal(store.appendEvent(event).seq, 1);
  assert.equal(store.listEvents('task-a').length, 1);
});

test('creates, resolves and bulk-cancels pending approvals', (t) => {
  const store = memoryStore(t);
  store.createTask(taskInput('task-a'));
  store.createTask(taskInput('task-b'));
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const input = approvalInput('resolve-me', 'task-a');
  const pending = store.createApproval(input);

  assert.deepEqual(pending, {
    ...input,
    status: 'PENDING',
    decision: null,
    decidedBy: null,
    createdAt: 1_000,
    decidedAt: null,
  });
  assert.deepEqual(store.getApproval(input.id), pending);
  assert.equal(store.getApproval('missing'), null);
  assert.deepEqual(store.listPendingApprovals(), [pending]);

  now = 2_000;
  const resolution = { id: input.id, decision: 'accept' as const, decidedBy: 'operator' };
  const resolved = store.resolveApproval(resolution);
  assert.deepEqual(resolved, {
    ...pending,
    status: 'DECIDED',
    decision: 'accept',
    decidedBy: 'operator',
    decidedAt: 2_000,
  });
  assert.throws(() => store.resolveApproval({ ...resolution, decision: 'decline' }), /pending/i);
  assert.throws(() => store.resolveApproval({ ...resolution, id: 'missing' }), /missing/i);
  assert.deepEqual(store.getApproval(input.id), resolved);

  store.createApproval(approvalInput('cancel-first', 'task-a'));
  store.createApproval(approvalInput('cancel-second', 'task-a'));
  const stillPending = store.createApproval(approvalInput('keep-pending', 'task-b'));
  assert.equal(store.listPendingApprovals().length, 3);
  assert.equal(store.cancelPendingApprovalsForTask('task-a'), 2);
  assert.equal(store.cancelPendingApprovalsForTask('task-a'), 0);
  assert.deepEqual(store.listApprovalsForTask('task-a').map(({ status }) => status),
    ['DECIDED', 'CANCELLED', 'CANCELLED']);
  assert.deepEqual(store.listPendingApprovals(), [stillPending]);
  assert.throws(() => store.resolveApproval({ ...resolution, id: 'cancel-first' }), /pending/i);
  assert.throws(() => store.createApproval(approvalInput('orphan', 'missing-task')), /foreign key/i);
});

test('returns audit logs newest first with ties ordered by insertion and honors the limit', (t) => {
  const store = memoryStore(t);
  t.mock.method(Date, 'now', () => 2_000);
  const start = store.appendAuditLog({
    origin: 'system', actor: 'hub', action: 'start', detail: { flags: ['ready'] },
  });
  const later = store.appendAuditLog({
    origin: 'gemini_app', actor: 'client-a', action: 'submit',
    projectId: 'project-a', taskId: 'task-a', detail: { tags: ['test'], metadata: { count: 2 } },
  });

  assert.deepEqual(start, {
    id: 1, origin: 'system', actor: 'hub', action: 'start',
    projectId: null, taskId: null, detail: { flags: ['ready'] }, createdAt: 2_000,
  });
  assert.deepEqual(later, {
    id: 2, origin: 'gemini_app', actor: 'client-a', action: 'submit', projectId: 'project-a',
    taskId: 'task-a', detail: { tags: ['test'], metadata: { count: 2 } }, createdAt: 2_000,
  });
  assert.deepEqual(store.listAuditLogs(), [later, start]);
  assert.deepEqual(store.listAuditLogs(1), [later]);
  assert.deepEqual(store.listAuditLogs(0), []);
});

test('creates a WAL database and preserves all records across connections and reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-collab-store-'));
  const dbPath = join(directory, 'nested', 'hub.sqlite');
  try {
    const first = createSqliteTaskStore(dbPath);
    try {
      const task = first.createTask(taskInput('persistent-task'));
      const event = { taskId: task.id, type: 'task_status' as const, payload: { status: 'QUEUED' } };
      assert.equal(first.appendEvent(event).seq, 1);

      const second = createSqliteTaskStore(dbPath);
      try {
        assert.deepEqual(second.getTask(task.id), task);
        assert.equal(second.appendEvent(event).seq, 2);
        assert.equal(first.appendEvent(event).seq, 3);
      } finally {
        second.close();
      }

      first.createApproval(approvalInput('persisted-approval', task.id));
      first.appendAuditLog({
        origin: 'system', actor: 'hub', action: 'persist', taskId: task.id, detail: {},
      });
      const inspection = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(inspection.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
      } finally {
        inspection.close();
      }
    } finally {
      first.close();
    }

    const reopened = createSqliteTaskStore(dbPath);
    try {
      assert.equal(reopened.getTask('persistent-task')?.status, 'QUEUED');
      assert.deepEqual(reopened.listEvents('persistent-task').map(({ seq }) => seq), [1, 2, 3]);
      assert.equal(reopened.getApproval('persisted-approval')?.status, 'PENDING');
      assert.equal(reopened.listAuditLogs(1)[0]?.action, 'persist');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

