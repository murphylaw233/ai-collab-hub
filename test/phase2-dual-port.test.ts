import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHubServer } from '../src/index.js';
import { SqliteOAuthStore } from '../src/oauth/oauth-store.js';
import { createSqliteTaskStore } from '../src/store/sqlite-store.js';
import type { HubConfig, ICodexRpcClient, InitializeResultSummary } from '../src/types.js';

function createMockCodexRpc(): ICodexRpcClient {
  const notificationHandlers = new Set<(method: string, params: Record<string, unknown>) => void>();
  const approvalHandlers = new Set<
    (req: { id: string | number; method: string; params: Record<string, unknown> }) => void
  >();
  const exitHandlers = new Set<(info: { code: number | null; signal: string | null }) => void>();

  let running = false;
  let threadSeq = 0;
  let turnSeq = 0;

  const emitNotification = (method: string, params: Record<string, unknown>) => {
    for (const handler of notificationHandlers) {
      handler(method, params);
    }
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
      const paramRecord =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : undefined;
      if (method === 'thread/start') {
        threadSeq += 1;
        return {
          thread: { id: `thread-dual-${threadSeq}`, model: 'mock-codex' },
          model: 'mock-codex',
        } as T;
      }
      if (method === 'thread/resume') {
        return { thread: { id: String(paramRecord?.threadId ?? 'thread-dual-1') } } as T;
      }
      if (method === 'turn/start') {
        turnSeq += 1;
        const threadId = String(paramRecord?.threadId ?? 'thread-dual-1');
        const turnId = `turn-dual-${turnSeq}`;
        const report = JSON.stringify({
          verdict: 'completed',
          summary: 'Remote precheck via dual-port gateway succeeded.',
          changed_files: [],
          risks_or_disagreements: [],
          verification_output: 'mock remote check passed',
          next_suggested_action: null,
        });

        setTimeout(() => {
          emitNotification('turn/started', {
            threadId,
            turn: { id: turnId, status: 'inProgress' },
          });
          emitNotification('item/completed', {
            threadId,
            turnId,
            item: {
              type: 'agentMessage',
              id: `msg-${turnId}`,
              text: report,
            },
          });
          emitNotification('turn/completed', {
            threadId,
            turn: { id: turnId, status: 'completed', error: null, items: [] },
          });
        }, 10);

        return { turn: { id: turnId, status: 'inProgress' } } as T;
      }
      if (method === 'turn/interrupt') {
        return {} as T;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    },
    notify(): void {
      // no-op
    },
    respondToServerRequest(): void {
      // no-op
    },
    rejectServerRequest(): void {
      // no-op
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onServerRequest(handler) {
      approvalHandlers.add(handler);
      return () => approvalHandlers.delete(handler);
    },
    onExit(handler) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
  };
}

test('Phase 2 dual-port server isolates routes, bridges OAuth MCP tasks, and enforces kill-switch', async (t: TestContext) => {
  const workspace = await mkdtemp(join(tmpdir(), 'ai-collab-hub-dualport-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'README.md'), 'line 1\ndual-port test marker\nline 3\n', 'utf8');

  const publicBaseUrl = 'https://dualport.tailnet.ts.net';
  const redirectUri = 'https://gemini.google.com/callback';
  const ownerPassphrase = 'phase2-dual-port-passphrase';
  const projectId = 'dualport-project';

  const config: HubConfig = {
    host: '127.0.0.1',
    port: 0,
    localToken: 'local-admin-secret-token',
    localTokenGenerated: false,
    dbPath: ':memory:',
    projects: [
      {
        id: projectId,
        name: 'Dual Port Project',
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
      maxTaskDurationMs: 30_000,
      maxFollowupTurns: 4,
      maxConsecutiveErrors: 3,
      maxCommandOutputBytes: 65_536,
      deltaFlushIntervalMs: 25,
    },
    remote: {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl,
      ownerPassphrase,
      allowedRedirectUriPrefixes: [redirectUri],
      accessTokenTtlSec: 3600,
      refreshTokenTtlSec: 86_400,
      maxStateLength: 16_384,
      allowRemoteDocsWrite: false,
    },
  };

  const hub = createHubServer({
    config,
    store: createSqliteTaskStore(':memory:'),
    oauthStore: new SqliteOAuthStore(':memory:'),
    rpcClient: createMockCodexRpc(),
  });
  await hub.start();
  const client = new Client({ name: 'gemini-app-sim', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => undefined);
    await hub.stop();
  });

  assert.ok(hub.remoteServer, 'remoteServer must exist when remote.enabled=true');
  assert.ok(hub.remoteUrl, 'remoteUrl must be populated after start');
  assert.ok(hub.remoteMcpUrl, 'remoteMcpUrl must be populated after start');

  // 1. Strict dual-port route isolation
  for (const path of ['/ui', '/api/health', '/api/tasks', '/mcp/local']) {
    const res: Response = await fetch(`${hub.remoteUrl}${path}`, {
      method: path === '/mcp/local' ? 'POST' : 'GET',
      headers: path === '/mcp/local' ? { Authorization: `Bearer ${config.localToken}` } : undefined,
    });
    assert.equal(res.status, 404, `Remote port must NOT expose ${path}`);
  }

  for (const path of ['/.well-known/oauth-authorization-server', '/oauth/register', '/mcp/remote']) {
    const res: Response = await fetch(`${hub.url}${path}`, {
      method: path === '/.well-known/oauth-authorization-server' ? 'GET' : 'POST',
    });
    assert.equal(res.status, 404, `Local port must NOT expose ${path}`);
  }

  // 2. DCR + OAuth 2.1 PKCE S256 with 3000-char opaque state
  const regRes = await fetch(`${hub.remoteUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Gemini Connected App',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(regRes.status, 201);
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const longState = 'st_' + randomBytes(2250).toString('base64url').slice(0, 2997);
  assert.equal(longState.length, 3000);
  const resource = `${publicBaseUrl}/mcp/remote`;

  const authGet = await fetch(
    `${hub.remoteUrl}/oauth/authorize?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        resource,
        state: longState,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
  );
  assert.equal(authGet.status, 200);
  const authHtml = await authGet.text();
  const csrf = authHtml.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const cookie = authGet.headers.get('set-cookie')?.split(';')[0];
  assert.ok(csrf && cookie);

  const authPost = await fetch(`${hub.remoteUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
    body: new URLSearchParams({
      csrf_token: csrf,
      passphrase: ownerPassphrase,
      decision: 'approve',
    }),
  });
  assert.equal(authPost.status, 302);
  const callbackUrl = new URL(authPost.headers.get('location')!);
  assert.equal(callbackUrl.searchParams.get('state'), longState);
  const code = callbackUrl.searchParams.get('code')!;
  assert.ok(code);

  const tokenRes = await fetch(`${hub.remoteUrl}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
      resource,
    }),
  });
  assert.equal(tokenRes.status, 200);
  const tokenJson = (await tokenRes.json()) as { access_token: string };
  assert.ok(tokenJson.access_token);

  // 3. Connect MCP client on remote port and run fs_read_lines + codex_submit
  const transport = new StreamableHTTPClientTransport(new URL(hub.remoteMcpUrl!), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokenJson.access_token}` },
    },
  });
  await client.connect(transport);

  const readRes = CallToolResultSchema.parse(
    await client.callTool({
      name: 'fs_read_lines',
      arguments: { projectId, relativePath: 'README.md', startLine: 2, endLine: 2 },
    })
  );
  assert.equal(readRes.isError, undefined);
  assert.match(readRes.content[0]?.type === 'text' ? readRes.content[0].text : '', /dual-port test marker/);

  const submitRes = CallToolResultSchema.parse(
    await client.callTool({
      name: 'codex_submit',
      arguments: {
        projectId,
        mode: 'precheck',
        prompt: 'Check dual-port collaboration readiness',
      },
    })
  );
  const submitData = JSON.parse(
    submitRes.content[0]?.type === 'text' ? submitRes.content[0].text : '{}'
  ) as { taskId: string };
  assert.ok(submitData.taskId);

  const waitRes = CallToolResultSchema.parse(
    await client.callTool({
      name: 'codex_wait',
      arguments: { taskId: submitData.taskId, timeoutMs: 5000 },
    })
  );
  const waitData = JSON.parse(
    waitRes.content[0]?.type === 'text' ? waitRes.content[0].text : '{}'
  ) as {
    status: string;
    structuredReport: { verdict: string };
    recentEvents: Array<{ summary?: unknown; payload?: unknown }>;
  };
  assert.equal(waitData.status, 'COMPLETED');
  assert.equal(waitData.structuredReport.verdict, 'completed');
  assert.ok(Array.isArray(waitData.recentEvents) && waitData.recentEvents.length > 0);
  for (const ev of waitData.recentEvents) {
    assert.equal(typeof ev.summary, 'string');
    assert.equal(ev.payload, undefined);
  }

  // Verify local /api/tasks sees origin = 'gemini_app'
  const tasksRes = await fetch(`${hub.url}/api/tasks`);
  assert.equal(tasksRes.status, 200);
  const tasksBody = (await tasksRes.json()) as {
    tasks: Array<{ id: string; origin: string; status: string }>;
  };
  const syncedTask = tasksBody.tasks.find((item) => item.id === submitData.taskId);
  assert.ok(syncedTask);
  assert.equal(syncedTask.origin, 'gemini_app');
  assert.equal(syncedTask.status, 'COMPLETED');

  // 4. Local /api/health reports remote status + active OAuth token count
  const healthBefore = (await (await fetch(`${hub.url}/api/health`)).json()) as {
    ok: boolean;
    remoteEnabled: boolean;
    remotePublicUrl: string | null;
    activeOAuthTokensCount: number;
  };
  assert.equal(healthBefore.ok, true);
  assert.equal(healthBefore.remoteEnabled, true);
  assert.equal(healthBefore.remotePublicUrl, publicBaseUrl);
  assert.equal(healthBefore.activeOAuthTokensCount, 1);

  // 5. Local CSRF-protected revoke-all kill-switch immediately invalidates remote MCP
  const csrfBlocked = await fetch(`${hub.url}/api/oauth/revoke-all`, { method: 'POST' });
  assert.equal(csrfBlocked.status, 403);

  const revokeRes = await fetch(`${hub.url}/api/oauth/revoke-all`, {
    method: 'POST',
    headers: { 'X-Requested-With': 'ai-collab-hub-ui' },
  });
  assert.equal(revokeRes.status, 200);
  const revokeBody = (await revokeRes.json()) as { ok: boolean; revoked: number };
  assert.deepEqual(revokeBody, { ok: true, revoked: 1 });

  const healthAfter = (await (await fetch(`${hub.url}/api/health`)).json()) as {
    activeOAuthTokensCount: number;
  };
  assert.equal(healthAfter.activeOAuthTokensCount, 0);

  await assert.rejects(
    client.listTools(),
    (error: unknown) => error instanceof StreamableHTTPError && error.code === 401
  );
});
