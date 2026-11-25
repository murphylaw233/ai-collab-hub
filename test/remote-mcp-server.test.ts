import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CodexAdapter } from '../src/codex/codex-adapter.js';
import { createRemoteMcpHandler } from '../src/mcp/remote-mcp-server.js';
import { createOAuthServer } from '../src/oauth/oauth-server.js';
import { SqliteOAuthStore } from '../src/oauth/oauth-store.js';
import { TaskManager } from '../src/orchestrator/task-manager.js';
import { FileSandbox } from '../src/sandbox/file-sandbox.js';
import { SqliteTaskStore } from '../src/store/sqlite-store.js';
import type {
  DirListResult, GitDiffResult, HubConfig, ICodexRpcClient, ReadLinesResult, SearchFilesResult, WriteDocResult,
} from '../src/types.js';

const publicBaseUrl = 'https://hub.example.test';
const redirectUri = 'https://client.example.test/callback';
const ownerPassphrase = 'test-only owner passphrase';
const projectId = 'test-project';
const searchQuery = 'needle-to-find';
const fileContents = 'first line\n' + searchQuery + '\nthird line';
const envContents = 'TEST_SECRET=example-secret-value';

function idleRpc(): ICodexRpcClient {
  const unexpected = () => { throw new Error('Unexpected Codex RPC call'); };
  const subscribe = () => () => {};
  return {
    start: unexpected,
    stop: async () => {},
    isRunning: () => false,
    getTransportInfo: () => ({ transport: 'stdio', wsUrl: null, wsTokenEnvVar: null, wsToken: null }),
    request: unexpected,
    notify: unexpected,
    respondToServerRequest: unexpected,
    rejectServerRequest: unexpected,
    onNotification: subscribe,
    onServerRequest: subscribe,
    onExit: subscribe,
  };
}

async function start(t: TestContext, allowRemoteDocsWrite: boolean) {
  const workspace = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.remote-mcp-workspace-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'notes.txt'), fileContents);
  await writeFile(join(workspace, '.env'), envContents);
  const git = (args: string[]) => execFileSync('git', args, { cwd: workspace, windowsHide: true });
  git(['init', '--quiet', '--template=']);
  git(['-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', 'add', '--', 'notes.txt']);

  const config: HubConfig = {
    host: '127.0.0.1', port: 0, localToken: 'test-local-token', localTokenGenerated: false, dbPath: ':memory:',
    projects: [{ id: projectId, name: 'Test project', rootPath: workspace, permissionMode: 'docs_write', docsSubdir: 'docs' }],
    codex: {
      transport: 'stdio', wsPort: 0, defaultApprovalPolicy: 'on-request',
      defaultSandbox: 'read-only', ephemeralThreads: true,
    },
    guardrails: {
      idempotencyCooldownMs: 60_000, maxTaskDurationMs: 30_000, maxFollowupTurns: 4,
      maxConsecutiveErrors: 3, maxCommandOutputBytes: 65_536, deltaFlushIntervalMs: 25,
    },
    remote: {
      enabled: true, host: '127.0.0.1', port: 0, publicBaseUrl, ownerPassphrase,
      allowedRedirectUriPrefixes: [redirectUri], accessTokenTtlSec: 3600, refreshTokenTtlSec: 86400,
      maxStateLength: 4096, allowRemoteDocsWrite,
    },
  };
  const oauthServer = createOAuthServer({ store: new SqliteOAuthStore(':memory:'), config: config.remote });
  const store = new SqliteTaskStore(':memory:');
  const sandbox = new FileSandbox(config.projects);
  const taskManager = new TaskManager(store, sandbox, new CodexAdapter(idleRpc(), config.codex), config);
  const handleRemoteMcp = createRemoteMcpHandler({
    oauthServer, store, sandbox, taskManager, allowRemoteDocsWrite,
    getMonitorUrl: () => 'http://127.0.0.1:3789/ui',
  });
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', publicBaseUrl);
      if (url.pathname === '/mcp/remote') {
        await handleRemoteMcp(req, res);
      } else if (!await oauthServer.handleHttpRequest(req, res, url)) {
        res.writeHead(404).end();
      }
    } catch (error) {
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end(String(error));
    }
  }).listen(0, '127.0.0.1');
  const client = new Client({ name: 'remote-test-client', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await taskManager.shutdown();
    oauthServer.close();
  });
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address === 'object');
  const baseUrl = 'http://127.0.0.1:' + address.port;
  return { request: (path: string, init?: RequestInit) => fetch(baseUrl + path, init), baseUrl, client, oauthServer, store, workspace };
}

async function connect({ request, baseUrl, client }: Awaited<ReturnType<typeof start>>) {
  const register = await request('/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  assert.equal(register.status, 201);
  const { client_id: clientId } = await register.json();
  assert.equal(typeof clientId, 'string');

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const resource = publicBaseUrl + '/mcp/remote';
  const authorize = await request('/oauth/authorize?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', resource, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }));
  assert.equal(authorize.status, 200);
  const csrf = (await authorize.text()).match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const cookie = authorize.headers.get('set-cookie')?.split(';')[0];
  assert(csrf && cookie);
  const approved = await request('/oauth/authorize', {
    method: 'POST', redirect: 'manual', headers: { Cookie: cookie },
    body: new URLSearchParams({ csrf_token: csrf, passphrase: ownerPassphrase, decision: 'approve' }),
  });
  assert.equal(approved.status, 302);
  const location = approved.headers.get('location');
  assert(location);
  const callback = new URL(location);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert(code);
  await approved.body?.cancel();

  const exchange = await request('/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code,
      code_verifier: verifier, resource,
    }),
  });
  assert.equal(exchange.status, 200);
  const { access_token: token, token_type: tokenType } = await exchange.json();
  assert.equal(tokenType, 'Bearer');
  assert.equal(typeof token, 'string');
  const headers = { Authorization: 'Bearer ' + token };
  const transport = new StreamableHTTPClientTransport(new URL('/mcp/remote', baseUrl), {
    requestInit: { headers },
  });
  await client.connect(transport);
  assert.equal(transport.sessionId, undefined);
  return headers;
}

function textContent(result: CallToolResult) {
  assert.equal(result.content.length, 1);
  const content = result.content[0];
  assert.equal(content.type, 'text');
  return content.text;
}

function toolData<T>(result: CallToolResult): T {
  assert(!result.isError, textContent(result));
  return JSON.parse(textContent(result));
}

async function callFileTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: { projectId, ...args } });
  return CallToolResultSchema.parse(result);
}

const readOnlyToolNames = [
  'project_list', 'codex_submit', 'codex_wait', 'codex_status', 'codex_result',
  'codex_followup', 'codex_interrupt', 'codex_list_tasks',
  'fs_list_dir', 'fs_read_lines', 'fs_search', 'fs_git_diff',
];

test('authenticates stateless MCP calls, guards reads, audits calls, and enforces revocation', async t => {
  const fixture = await start(t, false);
  const { client, request, oauthServer, store } = fixture;
  const unauthenticated = await request('/mcp/remote', { method: 'POST', body: '{' });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get('www-authenticate'),
    `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp/remote"`);
  assert(await unauthenticated.json());
  const headers = await connect(fixture);

  const get = await request('/mcp/remote', { headers });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert(await get.json());
  for (const [body, status] of [['{', 400], ['"' + 'é'.repeat(1024 * 1024) + '"', 413]] as const) {
    const response = await request('/mcp/remote', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body,
    });
    assert.equal(response.status, status);
    assert(await response.json());
  }

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), readOnlyToolNames.toSorted());
  const toolsJson = JSON.stringify(tools);
  assert(!toolsJson.includes('exclusiveMinimum'), 'tools schema must not emit exclusiveMinimum');
  assert(!toolsJson.includes('9007199254740991'), 'tools schema must not emit MAX_SAFE_INTEGER');
  const readSchema = tools.find(tool => tool.name === 'fs_read_lines')?.inputSchema;
  assert.deepEqual(readSchema?.required?.toSorted(), ['projectId', 'relativePath']);

  const call = (name: string, args?: Record<string, unknown>) => callFileTool(client, name, args);
  const listing = toolData<DirListResult>(await call('fs_list_dir', { maxDepth: 1 }));
  assert(listing.entries.some(entry => entry.relativePath === 'notes.txt'));
  assert(!listing.entries.some(entry => entry.relativePath === '.env'));
  const lines = toolData<ReadLinesResult>(await call('fs_read_lines', {
    relativePath: 'notes.txt', startLine: 2, endLine: 2,
  }));
  assert.equal(lines.content, searchQuery);
  const search = toolData<SearchFilesResult>(await call('fs_search', { query: searchQuery }));
  assert.deepEqual(search.matches, [{ relativePath: 'notes.txt', line: 2, preview: searchQuery }]);
  const diff = toolData<GitDiffResult>(await call('fs_git_diff'));
  assert.equal(diff.isGitRepo, true);
  assert(diff.diff.includes('+' + searchQuery));
  assert(!diff.statusPorcelain.includes('.env'));

  const denied = await call('fs_read_lines', { relativePath: '.env' });
  assert.equal(denied.isError, true);
  assert.match(textContent(denied), /sensitive paths/i);
  const invalid = await call('fs_read_lines', { relativePath: 'notes.txt', startLine: 'two' });
  assert.equal(invalid.isError, true);
  assert.match(textContent(invalid), /startLine/);

  const logs = store.listAuditLogs();
  assert.deepEqual(logs.map(log => log.action).sort(),
    ['fs_list_dir', 'fs_read_lines', 'fs_search', 'fs_git_diff', 'fs_read_lines', 'fs_read_lines'].sort());
  assert(logs.every(log => log.projectId === projectId && log.origin === 'gemini_app' && log.actor === 'gemini_app'));
  const audit = JSON.stringify(logs);
  assert(!audit.includes(searchQuery) && !audit.includes(envContents));
  assert(!audit.includes(headers.Authorization.slice('Bearer '.length)));

  assert.equal(oauthServer.revokeAllTokens(), 1);
  await assert.rejects(client.listTools(), (error: unknown) => error instanceof StreamableHTTPError && error.code === 401);
});

test('registers document writes only when enabled and confines them to docs', async t => {
  const fixture = await start(t, true);
  const { client, store, workspace } = fixture;
  await connect(fixture);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [...readOnlyToolNames, 'fs_write_doc'].sort());

  const content = '# Draft for review';
  const relativePath = 'docs/review.md';
  const result = toolData<WriteDocResult>(await callFileTool(client, 'fs_write_doc', { relativePath, content }));
  assert.deepEqual(result, { projectId, relativePath, bytesWritten: Buffer.byteLength(content) });
  assert.equal(await readFile(join(workspace, relativePath), 'utf8'), content);

  const denied = await callFileTool(client, 'fs_write_doc', { relativePath: 'outside.md', content });
  assert.equal(denied.isError, true);
  assert.match(textContent(denied), /inside docsSubdir/);
  await assert.rejects(readFile(join(workspace, 'outside.md')), { code: 'ENOENT' });
  const logs = store.listAuditLogs();
  assert.equal(logs.length, 2);
  assert(logs.every(log => log.action === 'fs_write_doc' && log.projectId === projectId
    && log.origin === 'gemini_app' && log.actor === 'gemini_app'));
  assert(!JSON.stringify(logs).includes(content));
});
