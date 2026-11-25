import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHubServer } from '../src/index.js';
import { createSqliteTaskStore } from '../src/store/sqlite-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function parseToolJson(result) {
  const text = result?.content?.[0]?.text ?? '';
  return JSON.parse(text);
}

async function main() {
  const config /** @type {HubConfig} */ = {
    host: '127.0.0.1',
    port: 0,
    localToken: 'phase1-live-e2e-token-123456',
    localTokenGenerated: false,
    dbPath: ':memory:',
    projects: [
      {
        id: 'ai-collab-hub',
        name: 'AI Collab Hub',
        rootPath: PROJECT_ROOT,
        permissionMode: 'read_only',
        docsSubdir: 'docs',
        description: 'Live Phase 1 E2E verification target',
      },
    ],
    codex: {
      transport: 'ws',
      wsPort: 0,
      defaultApprovalPolicy: 'on-request',
      defaultSandbox: 'read-only',
      ephemeralThreads: false,
    },
    guardrails: {
      idempotencyCooldownMs: 60_000,
      maxTaskDurationMs: 120_000,
      maxFollowupTurns: 4,
      maxConsecutiveErrors: 3,
      maxCommandOutputBytes: 65_536,
      deltaFlushIntervalMs: 100,
    },
  };

  const store = createSqliteTaskStore(':memory:');
  const hub = createHubServer({ config, store });
  await hub.start();
  console.log('[e2e] Hub started at', hub.url);

  const client = new Client({ name: 'phase1-e2e-antigravity', version: '0.1.0' });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(hub.mcpLocalUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${config.localToken}`,
        },
      },
    });
    await client.connect(transport);

    const projects = parseToolJson(await client.callTool({ name: 'project_list', arguments: {} }));
    assert.equal(projects.projects.length, 1);
    console.log('[e2e] project_list OK:', projects.projects[0].id);

    const submitted = parseToolJson(
      await client.callTool({
        name: 'codex_submit',
        arguments: {
          projectId: 'ai-collab-hub',
          mode: 'readonly_research',
          prompt:
            'Read package.json in this workspace (or inspect it without editing anything) and report its name and version in your structured report summary.',
          idempotencyKey: `phase1-e2e-${Date.now()}`,
        },
      })
    );
    const taskId = submitted.taskId;
    console.log('[e2e] codex_submit OK:', taskId);

    let waitResult = null;
    for (let i = 0; i < 6; i++) {
      waitResult = parseToolJson(
        await client.callTool({
          name: 'codex_wait',
          arguments: { taskId, timeoutMs: 20_000 },
        })
      );
      console.log(`[e2e] codex_wait #${i + 1}:`, waitResult.status, 'timedOut=', waitResult.timedOut);
      if (waitResult.status === 'COMPLETED' || waitResult.status === 'FAILED' || waitResult.status === 'CANCELLED') {
        break;
      }
      if (waitResult.status === 'WAITING_APPROVAL') {
        throw new Error(`Unexpected approval pause during readonly_research: ${JSON.stringify(waitResult.pendingApprovals)}`);
      }
    }

    assert.equal(waitResult?.status, 'COMPLETED', `Expected COMPLETED, got ${JSON.stringify(waitResult)}`);
    const result = parseToolJson(
      await client.callTool({
        name: 'codex_result',
        arguments: { taskId, includeEvents: true },
      })
    );
    console.log('[e2e] codex_result:', JSON.stringify({
      status: result.status,
      threadId: result.threadId,
      resumeCommand: result.resumeCommand,
      verdict: result.structuredReport?.verdict ?? null,
      summary: result.structuredReport?.summary ?? result.finalMessage,
      eventsCount: result.events?.length ?? 0,
    }));

    assert.ok(result.threadId, 'Expected non-null threadId');
    assert.ok(result.resumeCommand?.startsWith('codex resume '), 'Expected codex resume command');
    assert.ok(result.structuredReport, 'Expected structuredReport parsed from outputSchema');

    const healthRes = await fetch(`${hub.url}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    console.log('[e2e] /api/health:', JSON.stringify(health));
    assert.equal(health.ok, true);
    assert.equal(health.transport, 'ws');

    const detailRes = await fetch(`${hub.url}/api/tasks/${taskId}`);
    assert.equal(detailRes.status, 200);

    const eventsRes = await fetch(`${hub.url}/api/tasks/${taskId}/events?afterSeq=0`);
    assert.equal(eventsRes.status, 200);
    const eventsJson = await eventsRes.json();
    assert.ok(Array.isArray(eventsJson.events) && eventsJson.events.length > 0);
    console.log('[e2e] /api/tasks/:id/events count:', eventsJson.events.length);
    console.log('[e2e] PHASE1_E2E_PASS');
  } finally {
    await client.close().catch(() => undefined);
    await hub.stop();
  }
}

main().catch((err) => {
  console.error('[e2e] FAILED:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
