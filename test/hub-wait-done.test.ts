import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WAITER_SCRIPT = resolve(__dirname, '..', 'scripts', 'hub-wait-done.mjs');

interface MockTaskState {
  task: {
    id: string;
    projectId: string;
    mode: string;
    status: string;
    threadId: string | null;
    turnCount: number;
    structuredReport: Record<string, unknown> | null;
    finalMessage: string | null;
    lastError: string | null;
    tokenUsageJson: string | null;
  };
  approvals: Array<Record<string, unknown>>;
  resumeCommand: string | null;
}

async function startMockHub(t: TestContext, initialStates: Record<string, MockTaskState>) {
  const states = new Map(Object.entries(initialStates));
  const streams = new Map<string, Set<ServerResponse>>();

  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const detailMatch = /^\/api\/tasks\/([^/]+)$/.exec(reqUrl.pathname);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      const state = states.get(id);
      if (!state) {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state));
      return;
    }

    const streamMatch = /^\/api\/tasks\/([^/]+)\/stream$/.exec(reqUrl.pathname);
    if (streamMatch) {
      const id = decodeURIComponent(streamMatch[1]);
      const state = states.get(id);
      if (!state) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.write(`event: task_snapshot\ndata: ${JSON.stringify(state)}\n\n`);
      let set = streams.get(id);
      if (!set) {
        set = new Set();
        streams.set(id, set);
      }
      set.add(res);
      req.on('close', () => set?.delete(res));
      return;
    }

    res.writeHead(404).end();
  }).listen(0, '127.0.0.1');

  t.after(async () => {
    for (const set of streams.values()) {
      for (const res of set) res.end();
    }
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections?.();
    });
  });

  await once(server, 'listening');
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  const url = `http://127.0.0.1:${addr.port}`;

  const pushState = (id: string, next: MockTaskState) => {
    states.set(id, next);
    const set = streams.get(id);
    if (set) {
      for (const res of set) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: task_snapshot\ndata: ${JSON.stringify(next)}\n\n`);
        }
      }
    }
  };

  return { url, pushState };
}

function runWaiter(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [WAITER_SCRIPT, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => err.push(c));
    child.on('exit', (code) => {
      resolveRun({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function makeTask(id: string, status: string, extra: Partial<MockTaskState['task']> = {}): MockTaskState {
  const threadId = `thread-${id}`;
  return {
    task: {
      id,
      projectId: 'mota-solver',
      mode: 'readonly_research',
      status,
      threadId,
      turnCount: 1,
      structuredReport: null,
      finalMessage: null,
      lastError: null,
      tokenUsageJson: JSON.stringify({ last: { totalTokens: 95_000 }, modelContextWindow: 475_000 }),
      ...extra,
    },
    approvals: [],
    resumeCommand: `codex resume ${threadId}`,
  };
}

test('hub-wait-done resolves single task completion via SSE with exit 0', async (t: TestContext) => {
  const { url, pushState } = await startMockHub(t, {
    'task-1': makeTask('task-1', 'RUNNING'),
  });

  setTimeout(() => {
    pushState(
      'task-1',
      makeTask('task-1', 'COMPLETED', {
        structuredReport: {
          verdict: 'completed',
          summary: 'SSE completion works cleanly.',
          changed_files: ['src/a.ts'],
          risks_or_disagreements: [],
          verification_output: 'ok',
        },
      })
    );
  }, 80);

  const res = await runWaiter(['task-1', `--url=${url}`, '--timeout=5']);
  assert.equal(res.code, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.taskId, 'task-1');
  assert.equal(parsed.status, 'COMPLETED');
  assert.equal(parsed.verdict, 'completed');
  assert.equal(parsed.summary, 'SSE completion works cleanly.');
  assert.equal(parsed.contextUsage.pressure, 'low');
  assert.equal(parsed.resumeCommand, 'codex resume thread-task-1');
});

test('hub-wait-done returns exit code 2 when task enters WAITING_APPROVAL', async (t: TestContext) => {
  const { url, pushState } = await startMockHub(t, {
    'task-appr': makeTask('task-appr', 'RUNNING'),
  });

  setTimeout(() => {
    const next = makeTask('task-appr', 'WAITING_APPROVAL');
    next.approvals = [{ id: 'appr-1', status: 'PENDING', kind: 'command', summary: 'Run pytest', command: 'pytest' }];
    pushState('task-appr', next);
  }, 60);

  const res = await runWaiter(['task-appr', `--url=${url}`, '--timeout=5']);
  assert.equal(res.code, 2, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.status, 'WAITING_APPROVAL');
  assert.equal(parsed.pendingApprovals.length, 1);
  assert.equal(parsed.pendingApprovals[0].command, 'pytest');
});

test('hub-wait-done waits for multiple tasks with --mode=all and returns early with --mode=any', async (t: TestContext) => {
  const { url, pushState } = await startMockHub(t, {
    't-fast': makeTask('t-fast', 'RUNNING'),
    't-slow': makeTask('t-slow', 'RUNNING'),
  });

  setTimeout(() => {
    pushState(
      't-fast',
      makeTask('t-fast', 'COMPLETED', {
        structuredReport: { verdict: 'completed', summary: 'Fast finished', changed_files: [], risks_or_disagreements: [] },
      })
    );
  }, 60);

  setTimeout(() => {
    pushState(
      't-slow',
      makeTask('t-slow', 'COMPLETED', {
        structuredReport: { verdict: 'completed', summary: 'Slow finished', changed_files: [], risks_or_disagreements: [] },
      })
    );
  }, 1500);

  const anyRes = await runWaiter(['t-fast', 't-slow', '--mode=any', `--url=${url}`, '--timeout=5']);
  assert.equal(anyRes.code, 0, anyRes.stderr);
  const anyJson = JSON.parse(anyRes.stdout);
  assert.equal(anyJson.mode, 'any');
  assert.equal(anyJson.timedOutWaiting, false);
  assert.equal(anyJson.completedCount, 1);
  assert.equal(anyJson.totalCount, 2);

  const allRes = await runWaiter(['t-fast', 't-slow', '--mode=all', `--url=${url}`, '--timeout=5']);
  assert.equal(allRes.code, 0, allRes.stderr);
  const allJson = JSON.parse(allRes.stdout);
  assert.equal(allJson.mode, 'all');
  assert.equal(allJson.timedOutWaiting, false);
  assert.equal(allJson.completedCount, 2);
  assert.equal(allJson.totalCount, 2);
});
