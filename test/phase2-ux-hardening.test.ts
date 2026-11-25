import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodexAdapter } from '../src/codex/codex-adapter.js';
import { createCodexRpcClient } from '../src/codex/rpc-client.js';
import { createHubServer } from '../src/index.js';
import {
  compactEventsForWait,
  computeContextUsage,
  TaskManager,
} from '../src/orchestrator/task-manager.js';
import { FileSandbox } from '../src/sandbox/file-sandbox.js';
import { createSqliteTaskStore } from '../src/store/sqlite-store.js';
import type {
  HubConfig,
  ICodexRpcClient,
  InitializeResultSummary,
  TaskEventRecord,
} from '../src/types.js';

function createInteractiveMockRpc(handlers: {
  onTurnStart: (
    params: Record<string, unknown>,
    emit: (method: string, payload: Record<string, unknown>) => void
  ) => string;
  onTurnSteer?: (params: Record<string, unknown>) => void;
}): ICodexRpcClient {
  const notifListeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  const approvalListeners = new Set<
    (req: { id: string | number; method: string; params: Record<string, unknown> }) => void
  >();
  const exitListeners = new Set<(info: { code: number | null; signal: string | null }) => void>();

  let running = false;
  let threadSeq = 0;

  const emit = (method: string, params: Record<string, unknown>) => {
    for (const fn of notifListeners) fn(method, params);
  };

  return {
    async start(): Promise<InitializeResultSummary> {
      running = true;
      return {
        userAgent: 'mock-codex/0.172.0',
        platformFamily: 'windows',
        platformOs: 'windows',
        raw: {},
      };
    },
    async stop(): Promise<void> {
      running = false;
    },
    isRunning: () => running,
    getTransportInfo: () => ({
      transport: 'stdio',
      wsUrl: null,
      wsTokenEnvVar: null,
      wsToken: null,
    }),
    async request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const p = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
      if (method === 'thread/start') {
        threadSeq += 1;
        return { thread: { id: `thread-ux-${threadSeq}`, model: 'gpt-6.2-sol' }, model: 'gpt-6.2-sol' } as T;
      }
      if (method === 'thread/resume') {
        return { thread: { id: String(p.threadId ?? 'thread-ux-1') } } as T;
      }
      if (method === 'turn/start') {
        const turnId = handlers.onTurnStart(p, emit);
        return { turn: { id: turnId, status: 'inProgress' } } as T;
      }
      if (method === 'turn/steer') {
        handlers.onTurnSteer?.(p);
        return {} as T;
      }
      if (method === 'turn/interrupt') {
        return {} as T;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    },
    notify(): void {},
    respondToServerRequest(): void {},
    rejectServerRequest(): void {},
    onNotification(handler) {
      notifListeners.add(handler);
      return () => notifListeners.delete(handler);
    },
    onServerRequest(handler) {
      approvalListeners.add(handler);
      return () => approvalListeners.delete(handler);
    },
    onExit(handler) {
      exitListeners.add(handler);
      return () => exitListeners.delete(handler);
    },
  };
}

function makeConfig(workspace: string, maxTaskDurationMs = 30_000): HubConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    localToken: 'ux-hardening-local-token',
    localTokenGenerated: false,
    dbPath: ':memory:',
    projects: [
      {
        id: 'ux-proj',
        name: 'UX Project',
        rootPath: workspace,
        permissionMode: 'codex_work',
        docsSubdir: 'docs',
      },
    ],
    codex: {
      transport: 'stdio',
      wsPort: 0,
      defaultApprovalPolicy: 'on-request',
      defaultSandbox: 'workspace-write',
      ephemeralThreads: false,
    },
    guardrails: {
      idempotencyCooldownMs: 60_000,
      maxTaskDurationMs,
      maxFollowupTurns: 6,
      maxConsecutiveErrors: 3,
      maxCommandOutputBytes: 65_536,
      deltaFlushIntervalMs: 20,
    },
    remote: {
      enabled: false,
      host: '127.0.0.1',
      port: 3790,
      allowedRedirectUriPrefixes: ['https://oauth-redirect.googleusercontent.com/'],
      accessTokenTtlSec: 3600,
      refreshTokenTtlSec: 86_400,
      maxStateLength: 16_384,
      allowRemoteDocsWrite: false,
    },
  };
}

test('computeContextUsage classifies utilization tiers and emits recommendations', () => {
  assert.equal(computeContextUsage(null).pressure, 'unknown');

  const low = computeContextUsage(
    JSON.stringify({ last: { totalTokens: 50_000 }, total: { totalTokens: 50_000 }, modelContextWindow: 475_000 })
  );
  assert.equal(low.pressure, 'low');
  assert.equal(low.recommendation, null);

  const medium = computeContextUsage(
    JSON.stringify({ last: { totalTokens: 200_000 }, total: { totalTokens: 400_000 }, modelContextWindow: 475_000 })
  );
  assert.equal(medium.pressure, 'medium');

  const high = computeContextUsage(
    JSON.stringify({ last: { totalTokens: 320_000 }, total: { totalTokens: 700_000 }, modelContextWindow: 475_000 })
  );
  assert.equal(high.pressure, 'high');
  assert.match(high.recommendation ?? '', /fresh codex_submit/i);

  const critical = computeContextUsage(
    JSON.stringify({ last: { totalTokens: 400_000 }, total: { totalTokens: 1_200_000 }, modelContextWindow: 475_000 })
  );
  assert.equal(critical.pressure, 'critical');
  assert.match(critical.recommendation ?? '', /80%/);
});

test('compactEventsForWait coalesces streaming delta bursts and highlights commands', () => {
  const base: Omit<TaskEventRecord, 'id' | 'seq' | 'type' | 'payload'> = {
    taskId: 'task-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    createdAt: 1000,
  };
  const events: TaskEventRecord[] = [
    { ...base, id: 1, seq: 1, type: 'command_started', payload: { item: { command: 'python solve.py' } } },
    { ...base, id: 2, seq: 2, type: 'command_output', payload: { delta: 'line1 ' } },
    { ...base, id: 3, seq: 3, type: 'command_output', payload: { delta: 'line2' } },
    { ...base, id: 4, seq: 4, type: 'command_completed', payload: { item: { command: 'python solve.py', exitCode: 0, durationMs: 42 } } },
    { ...base, id: 5, seq: 5, type: 'token_usage', payload: { tokenUsage: {} } },
    { ...base, id: 6, seq: 6, itemId: 'msg-1', type: 'agent_message_delta', payload: { delta: 'Hello ' } },
    { ...base, id: 7, seq: 7, itemId: 'msg-1', type: 'agent_message_delta', payload: { delta: 'world!' } },
  ];

  const compacted = compactEventsForWait(events, 15);
  assert.equal(compacted.length, 4);
  assert.equal(compacted[0].summary, 'Running: python solve.py');
  assert.equal(compacted[1].summary, 'line1 line2');
  assert.equal(compacted[1].mergedCount, 2);
  assert.equal(compacted[2].summary, 'Completed (exit=0, 42ms): python solve.py');
  assert.equal(compacted[3].summary, 'Hello world!');
  assert.equal(compacted[3].mergedCount, 2);
});

test('codex_wait enforces 15s max, incremental afterSeq, progress tracking, and per-turn isolation', async (t: TestContext) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-ux-wait-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  let turnCount = 0;
  let releaseTurn2: (() => void) | null = null;

  const rpc = createInteractiveMockRpc({
    onTurnStart(params, emit) {
      turnCount += 1;
      const threadId = String(params.threadId);
      const turnId = `turn-ux-${turnCount}`;
      if (turnCount === 1) {
        setTimeout(() => {
          emit('turn/started', { threadId, turn: { id: turnId } });
          emit('item/started', {
            threadId,
            turnId,
            item: { id: 'cmd-1', type: 'commandExecution', command: 'pytest -q' },
          });
          emit('item/completed', {
            threadId,
            turnId,
            item: { id: 'cmd-1', type: 'commandExecution', command: 'pytest -q', exitCode: 0, durationMs: 120 },
          });
          const report = JSON.stringify({
            verdict: 'completed',
            summary: 'TURN_1_SUMMARY',
            risks_or_disagreements: [],
            changed_files: [],
            verification_output: 'ok',
            next_suggested_action: null,
          });
          emit('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: report.slice(0, 20) });
          emit('item/agentMessage/delta', { threadId, turnId, itemId: 'msg-1', delta: report.slice(20) });
          emit('item/completed', {
            threadId,
            turnId,
            item: { id: 'msg-1', type: 'agentMessage', text: report },
          });
          emit('turn/completed', {
            threadId,
            turn: { id: turnId, status: 'completed', error: null, items: [] },
          });
        }, 15);
      } else {
        setTimeout(() => {
          emit('turn/started', { threadId, turn: { id: turnId } });
          emit('item/started', {
            threadId,
            turnId,
            item: { id: 'cmd-2', type: 'commandExecution', command: 'python solver.py' },
          });
          releaseTurn2 = () => {
            emit('turn/completed', {
              threadId,
              turn: { id: turnId, status: 'failed', error: 'Turn 2 intentional failure', items: [] },
            });
          };
        }, 15);
      }
      return turnId;
    },
  });

  const hub = createHubServer({
    config: makeConfig(workspace),
    store: createSqliteTaskStore(':memory:'),
    rpcClient: rpc,
  });
  await hub.start();
  const client = new Client({ name: 'ux-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await hub.stop();
  });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(hub.mcpLocalUrl), {
      requestInit: { headers: { Authorization: 'Bearer ux-hardening-local-token' } },
    })
  );

  const submitRes = CallToolResultSchema.parse(
    await client.callTool({
      name: 'codex_submit',
      arguments: { projectId: 'ux-proj', mode: 'readonly_research', prompt: 'Analyze solver' },
    })
  );
  const { taskId } = JSON.parse(submitRes.content[0]?.type === 'text' ? submitRes.content[0].text : '{}') as {
    taskId: string;
  };

  // Rejects timeoutMs > 15000
  const badTimeout = CallToolResultSchema.parse(
    await client.callTool({ name: 'codex_wait', arguments: { taskId, timeoutMs: 20_000 } })
  );
  assert.equal(badTimeout.isError, true);

  const wait1 = CallToolResultSchema.parse(
    await client.callTool({ name: 'codex_wait', arguments: { taskId, timeoutMs: 5_000 } })
  );
  const data1 = JSON.parse(wait1.content[0]?.type === 'text' ? wait1.content[0].text : '{}') as {
    status: string;
    lastSeq: number;
    structuredReport: { summary: string };
    progress: { phase: string; lastCommand: { command: string; exitCode: number } | null };
    recentEvents: Array<{ seq: number; summary: string }>;
  };
  assert.equal(data1.status, 'COMPLETED');
  assert.equal(data1.structuredReport.summary, 'TURN_1_SUMMARY');
  assert.equal(data1.progress.phase, 'completed');
  assert.equal(data1.progress.lastCommand?.command, 'pytest -q');
  assert.equal(data1.progress.lastCommand?.exitCode, 0);
  assert.ok(data1.lastSeq > 0);

  // Follow-up clears Turn 1 structuredReport immediately
  await client.callTool({
    name: 'codex_followup',
    arguments: { taskId, prompt: 'Second turn check' },
  });

  const wait2a = CallToolResultSchema.parse(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId, timeoutMs: 500, afterSeq: data1.lastSeq },
    })
  );
  const data2a = JSON.parse(wait2a.content[0]?.type === 'text' ? wait2a.content[0].text : '{}') as {
    status: string;
    timedOut: boolean;
    lastSeq: number;
    structuredReport: unknown;
    progress: { phase: string; activeCommand: string | null };
    recentEvents: Array<{ seq: number; summary: string }>;
  };
  assert.equal(data2a.status, 'RUNNING');
  assert.equal(data2a.timedOut, true);
  assert.equal(data2a.structuredReport, null, 'Turn 1 report must not leak into Turn 2 polling');
  assert.equal(data2a.progress.phase, 'running_command');
  assert.equal(data2a.progress.activeCommand, 'python solver.py');
  assert.ok(data2a.recentEvents.every((ev) => ev.seq > data1.lastSeq));
  assert.ok(data2a.lastSeq > data1.lastSeq);

  // Polling again with lastSeq when nothing changed returns empty events
  const wait2b = CallToolResultSchema.parse(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId, timeoutMs: 500, afterSeq: data2a.lastSeq },
    })
  );
  const data2b = JSON.parse(wait2b.content[0]?.type === 'text' ? wait2b.content[0].text : '{}') as {
    recentEvents: unknown[];
    lastSeq: number;
  };
  assert.equal(data2b.recentEvents.length, 0);
  assert.equal(data2b.lastSeq, data2a.lastSeq);

  // Even after Turn 2 fails, Turn 1 report remains absent
  assert.ok(releaseTurn2);
  (releaseTurn2 as () => void)();
  const wait2End = CallToolResultSchema.parse(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId, timeoutMs: 5_000, afterSeq: data2b.lastSeq },
    })
  );
  const data2End = JSON.parse(wait2End.content[0]?.type === 'text' ? wait2End.content[0].text : '{}') as {
    status: string;
    structuredReport: unknown;
  };
  assert.equal(data2End.status, 'FAILED');
  assert.equal(data2End.structuredReport, null);
});

test('soft timeout sends wrap-up turn/steer and hard timeout preserves partial output', async (t: TestContext) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-ux-soft-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const steerPrompts: string[] = [];
  const rpc = createInteractiveMockRpc({
    onTurnStart(params, emit) {
      const threadId = String(params.threadId);
      const turnId = 'turn-soft-1';
      setTimeout(() => {
        emit('turn/started', { threadId, turn: { id: turnId } });
        emit('item/agentMessage/delta', {
          threadId,
          turnId,
          itemId: 'msg-soft',
          delta: 'Partial finding: state table verified in solver.py',
        });
      }, 20);
      return turnId;
    },
    onTurnSteer(params) {
      const input = Array.isArray(params.input) ? (params.input as Array<{ text?: string }>) : [];
      steerPrompts.push(String(input[0]?.text ?? ''));
    },
  });

  const config = makeConfig(workspace, 450);
  const store = createSqliteTaskStore(':memory:');
  const sandbox = new FileSandbox(config.projects);
  const tm = new TaskManager(store, sandbox, new CodexAdapter(rpc, config.codex), config);
  t.after(async () => {
    await tm.shutdown();
  });

  const submitted = tm.submitTask({
    origin: 'antigravity',
    projectId: 'ux-proj',
    mode: 'readonly_research',
    prompt: 'Long research that hits timeout',
  });
  const res = await tm.waitTask(submitted.task.id, 3_000);
  assert.equal(res.task.status, 'FAILED');
  assert.equal(res.progress.softTimeoutTriggered, true);
  assert.equal(steerPrompts.length, 1);
  assert.match(steerPrompts[0], /TIME LIMIT WARNING/);
  assert.match(res.task.finalMessage ?? '', /Partial output preserved before timeout/);
  assert.match(res.task.finalMessage ?? '', /state table verified in solver\.py/);
});

test('CodexRpcClient injects PYTHONUTF8=1 and PYTHONIOENCODING=utf-8 into spawned server env', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-ux-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mockScript = join(dir, 'env-echo-server.mjs');
  await writeFile(
    mockScript,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: {
        userAgent: 'env-echo/1.0',
        platformFamily: 'windows',
        platformOs: 'windows',
        pythonUtf8: process.env.PYTHONUTF8,
        pythonIoEncoding: process.env.PYTHONIOENCODING,
      },
    }) + '\\n');
  }
});
`,
    'utf8'
  );

  const client = createCodexRpcClient({
    binPath: mockScript,
    transport: 'stdio',
    clientInfo: { name: 'env-probe', title: 'Env Probe', version: '0.1.0' },
  });
  t.after(async () => {
    await client.stop();
  });

  const init = await client.start();
  assert.equal(init.raw.pythonUtf8, '1');
  assert.equal(init.raw.pythonIoEncoding, 'utf-8');
});

test('FileSandbox.gitStatusAndDiff renders Chinese filenames without octal escapes', async (t: TestContext) => {
  const workspace = await mkdtemp(join(tmpdir(), 'hub-ux-git-cjk-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const cjkName = '中文测试.txt';
  await writeFile(join(workspace, cjkName), '第一行中文\n', 'utf8');

  const git = (args: string[]) => execFileSync('git', args, { cwd: workspace, windowsHide: true });
  git(['init', '--quiet', '--template=']);

  const sandbox = new FileSandbox([
    {
      id: 'cjk-proj',
      name: 'CJK Git Project',
      rootPath: workspace,
      permissionMode: 'read_only',
      docsSubdir: 'docs',
    },
  ]);

  const diff = await sandbox.gitStatusAndDiff('cjk-proj', { includeUntracked: true });
  assert.equal(diff.isGitRepo, true);
  assert.ok(
    diff.statusPorcelain.includes(cjkName),
    `Expected unescaped Chinese filename in statusPorcelain, got: ${diff.statusPorcelain}`
  );
});
