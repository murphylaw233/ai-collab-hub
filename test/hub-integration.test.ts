import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCodexRpcClient } from '../src/codex/rpc-client.js';
import { createHubServer } from '../src/index.js';
import { createSqliteTaskStore } from '../src/store/sqlite-store.js';
import type { HubConfig } from '../src/types.js';

const MOCK_APP_SERVER_SOURCE = `
import { createInterface } from 'node:readline';

let nextThread = 1;
let nextTurn = 1;
const pendingApprovals = new Map();
const interruptedTurns = new Set();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.id !== undefined && !msg.method) {
    const resolver = pendingApprovals.get(msg.id);
    if (resolver) {
      pendingApprovals.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  switch (msg.method) {
    case 'initialize':
      send({
        id: msg.id,
        result: {
          userAgent: 'mock-codex/0.172.0',
          platformFamily: 'windows',
          platformOs: 'windows',
        },
      });
      break;
    case 'initialized':
      break;
    case 'thread/start': {
      const threadId = 'thread-mock-' + nextThread++;
      send({
        id: msg.id,
        result: {
          thread: { id: threadId, model: 'gpt-6.2-sol', modelProvider: 'openai' },
          model: 'gpt-6.2-sol',
          modelProvider: 'openai',
        },
      });
      break;
    }
    case 'thread/resume':
      send({ id: msg.id, result: { thread: { id: msg.params.threadId } } });
      break;
    case 'turn/interrupt':
      interruptedTurns.add(msg.params.turnId);
      send({ id: msg.id, result: {} });
      send({
        method: 'turn/completed',
        params: {
          threadId: msg.params.threadId,
          turn: { id: msg.params.turnId, status: 'interrupted', error: null, items: [] },
        },
      });
      break;
    case 'turn/start': {
      const threadId = msg.params.threadId;
      const turnId = 'turn-mock-' + nextTurn++;
      const promptText = msg.params.input?.[0]?.text ?? '';
      send({ id: msg.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      send({ method: 'turn/started', params: { threadId, turn: { id: turnId, status: 'inProgress' } } });

      if (promptText.includes('HANG_FOREVER')) {
        return;
      }

      if (promptText.includes('TRIGGER_APPROVAL')) {
        send({
          method: 'turn/plan/updated',
          params: {
            threadId,
            turnId,
            explanation: 'Testing approval flow',
            plan: [{ step: 'Run command', status: 'inProgress' }],
          },
        });
        send({
          method: 'item/started',
          params: {
            threadId,
            turnId,
            item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: msg.params.cwd, status: 'inProgress' },
          },
        });
        send({
          method: 'item/commandExecution/outputDelta',
          params: { threadId, turnId, itemId: 'cmd-1', delta: 'running tests...\\n' },
        });
        send({
          method: 'turn/diff/updated',
          params: { threadId, turnId, diff: '--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n' },
        });

        const rpcApprovalId = 9001;
        pendingApprovals.set(rpcApprovalId, (decisionResult) => {
          if (interruptedTurns.has(turnId)) return;
          send({
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test', status: 'completed', exitCode: 0 },
            },
          });
          const report = {
            verdict: 'completed',
            summary: 'Approved with decision: ' + (decisionResult?.decision ?? 'unknown'),
            risks_or_disagreements: [],
            changed_files: ['src/a.ts'],
            verification_output: 'mock tests passed',
            next_suggested_action: null,
          };
          const jsonText = JSON.stringify(report);
          send({
            method: 'item/agentMessage/delta',
            params: { threadId, turnId, itemId: 'msg-1', delta: jsonText },
          });
          send({
            method: 'item/completed',
            params: {
              threadId,
              turnId,
              item: { id: 'msg-1', type: 'agentMessage', text: jsonText },
            },
          });
          send({
            method: 'thread/tokenUsage/updated',
            params: { threadId, turnId, tokenUsage: { total: 42 } },
          });
          send({
            method: 'turn/completed',
            params: { threadId, turnId, turn: { id: turnId, status: 'completed', error: null, items: [] } },
          });
        });

        send({
          id: rpcApprovalId,
          method: 'item/commandExecution/requestApproval',
          params: {
            kind: 'command',
            threadId,
            turnId,
            itemId: 'cmd-1',
            startedAtMs: Date.now(),
            environmentId: null,
            command: 'npm test',
            cwd: msg.params.cwd,
            reason: 'Verify changes',
          },
        });
      } else {
        const report = {
          verdict: 'completed',
          summary: 'Quick mock completed',
          risks_or_disagreements: [],
          changed_files: [],
          verification_output: 'ok',
          next_suggested_action: null,
        };
        const jsonText = JSON.stringify(report);
        send({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: { id: 'msg-fast', type: 'agentMessage', text: jsonText },
          },
        });
        send({
          method: 'turn/completed',
          params: { threadId, turnId, turn: { id: turnId, status: 'completed', error: null, items: [] } },
        });
      }
      break;
    }
    default:
      send({ id: msg.id, error: { code: -32601, message: 'Unknown method: ' + msg.method } });
      break;
  }
});
`;

async function createTestHub(t: TestContext) {
  const workDir = mkdtempSync(join(tmpdir(), 'hub-int-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const mockScript = join(workDir, 'mock-codex.mjs');
  writeFileSync(mockScript, MOCK_APP_SERVER_SOURCE, 'utf8');

  const readonlyDir = join(workDir, 'repo-ro');
  const writableDir = join(workDir, 'repo-rw');
  rmSync(readonlyDir, { recursive: true, force: true });
  rmSync(writableDir, { recursive: true, force: true });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(readonlyDir);
  mkdirSync(writableDir);

  const config: HubConfig = {
    host: '127.0.0.1',
    port: 0,
    localToken: 'hub-integration-secret-token-1234',
    localTokenGenerated: false,
    dbPath: ':memory:',
    projects: [
      {
        id: 'ro-proj',
        name: 'Read Only Project',
        rootPath: readonlyDir,
        permissionMode: 'read_only',
        docsSubdir: 'docs',
      },
      {
        id: 'rw-proj',
        name: 'Writable Project',
        rootPath: writableDir,
        permissionMode: 'codex_work',
        docsSubdir: 'docs',
      },
    ],
    codex: {
      binPath: mockScript,
      transport: 'stdio',
      wsPort: 0,
      defaultApprovalPolicy: 'on-request',
      defaultSandbox: 'workspace-write',
      ephemeralThreads: false,
    },
    guardrails: {
      idempotencyCooldownMs: 60_000,
      maxTaskDurationMs: 30_000,
      maxFollowupTurns: 4,
      maxConsecutiveErrors: 3,
      maxCommandOutputBytes: 65_536,
      deltaFlushIntervalMs: 25,
    },
    remote: {
      enabled: false,
      host: '127.0.0.1',
      port: 3790,
      allowedRedirectUriPrefixes: [],
      accessTokenTtlSec: 3600,
      refreshTokenTtlSec: 2_592_000,
      maxStateLength: 16_384,
      allowRemoteDocsWrite: false,
    },
  };

  const store = createSqliteTaskStore(':memory:');
  const rpcClient = createCodexRpcClient({
    binPath: mockScript,
    transport: 'stdio',
  });
  const hub = createHubServer({ config, store, rpcClient });
  await hub.start();
  t.after(() => hub.stop());

  return { hub, config };
}

async function connectMcpClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test-antigravity', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  await client.connect(transport);
  return client;
}

function parseToolJson(result: Awaited<ReturnType<Client['callTool']>>) {
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? '';
  return JSON.parse(text);
}

test('MCP auth, permissions, deduplication, write lock, L2 UI approval, SSE, and interrupt flow', async (t) => {
  const { hub, config } = await createTestHub(t);

  // 1. /mcp/local enforces Bearer auth
  const unauthRes = await fetch(hub.mcpLocalUrl, { method: 'POST', body: '{}' });
  assert.equal(unauthRes.status, 401);

  const client = await connectMcpClient(hub.mcpLocalUrl, config.localToken);
  t.after(() => client.close());

  // 2. project_list and read_only execute guard
  const projRes = parseToolJson(await client.callTool({ name: 'project_list', arguments: {} }));
  assert.equal(projRes.projects.length, 2);

  const deniedExec = await client.callTool({
    name: 'codex_submit',
    arguments: { projectId: 'ro-proj', mode: 'execute', prompt: 'Should fail' },
  });
  assert.equal(deniedExec.isError, true);

  // 3. Submit execute task triggering L2 approval, verify dedupe & write lock
  const sub1 = parseToolJson(
    await client.callTool({
      name: 'codex_submit',
      arguments: {
        projectId: 'rw-proj',
        mode: 'execute',
        prompt: 'TRIGGER_APPROVAL',
        idempotencyKey: 'key-1',
      },
    })
  );
  assert.equal(sub1.deduplicated, false);
  const taskId = sub1.taskId as string;

  const subDup = parseToolJson(
    await client.callTool({
      name: 'codex_submit',
      arguments: {
        projectId: 'rw-proj',
        mode: 'execute',
        prompt: 'TRIGGER_APPROVAL',
        idempotencyKey: 'key-1',
      },
    })
  );
  assert.equal(subDup.deduplicated, true);
  assert.equal(subDup.taskId, taskId);

  const lockErr = await client.callTool({
    name: 'codex_submit',
    arguments: { projectId: 'rw-proj', mode: 'execute', prompt: 'Second concurrent write' },
  });
  assert.equal(lockErr.isError, true);

  // 4. codex_wait pauses on WAITING_APPROVAL with pending approval
  const waitPaused = parseToolJson(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId, timeoutMs: 5_000 },
    })
  );
  assert.equal(waitPaused.status, 'WAITING_APPROVAL');
  assert.equal(waitPaused.pendingApprovals.length, 1);
  const approvalId = waitPaused.pendingApprovals[0].id as string;

  // 5. UI endpoint CSRF check & desktop approval decision
  const csrfFail = await fetch(`${hub.url}/api/approvals/${approvalId}/decide`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'accept' }),
  });
  assert.equal(csrfFail.status, 403);

  const approveOk = await fetch(`${hub.url}/api/approvals/${approvalId}/decide`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ai-collab-hub-ui',
    },
    body: JSON.stringify({ decision: 'accept' }),
  });
  assert.equal(approveOk.status, 200);

  // 6. Wait for completion and verify structuredResult + latestDiff + UI/SSE
  const waitDone = parseToolJson(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId, timeoutMs: 5_000 },
    })
  );
  assert.equal(waitDone.status, 'COMPLETED');
  assert.match(waitDone.resumeCommand, /^codex resume thread-mock-/);

  const result = parseToolJson(
    await client.callTool({
      name: 'codex_result',
      arguments: { taskId, includeEvents: true },
    })
  );
  assert.equal(result.structuredReport.verdict, 'completed');
  assert.match(result.structuredReport.summary, /accept/);
  assert.match(result.latestDiff, /\+new/);
  assert.ok(result.events.length >= 4);

  const uiRes = await fetch(`${hub.url}/ui`);
  assert.equal(uiRes.status, 200);
  const uiHtml = await uiRes.text();
  assert.match(uiHtml, /AI Collab Hub/);

  // SSE stream replays events & emits task_snapshot
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${hub.url}/api/tasks/${taskId}/stream?afterSeq=0`, {
    signal: sseAbort.signal,
  });
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = sseRes.body!.getReader();
  let sseText = '';
  while (sseText.length < 200) {
    const chunk = await reader.read();
    if (chunk.done) break;
    sseText += Buffer.from(chunk.value).toString('utf8');
    if (sseText.includes('event: task_snapshot')) break;
  }
  sseAbort.abort();
  assert.match(sseText, /event: task_event/);
  assert.match(sseText, /event: task_snapshot/);

  // 7. Interrupt hanging task and verify lock released
  const hangSub = parseToolJson(
    await client.callTool({
      name: 'codex_submit',
      arguments: { projectId: 'rw-proj', mode: 'execute', prompt: 'HANG_FOREVER' },
    })
  );
  const hangId = hangSub.taskId as string;
  // Wait briefly for thread/turn startup
  await client.callTool({ name: 'codex_wait', arguments: { taskId: hangId, timeoutMs: 500 } });

  const interruptRes = parseToolJson(
    await client.callTool({ name: 'codex_interrupt', arguments: { taskId: hangId } })
  );
  assert.equal(interruptRes.status, 'CANCELLED');

  // Lock should be released now so a new execute task succeeds
  const afterInterrupt = parseToolJson(
    await client.callTool({
      name: 'codex_submit',
      arguments: { projectId: 'rw-proj', mode: 'execute', prompt: 'After interrupt' },
    })
  );
  assert.equal(afterInterrupt.deduplicated, false);
  const afterDone = parseToolJson(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId: afterInterrupt.taskId, timeoutMs: 5_000 },
    })
  );
  assert.equal(afterDone.status, 'COMPLETED');
});
