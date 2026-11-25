import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadHubConfig } from '../src/config.js';
import { createHubServer } from '../src/index.js';
import { SqliteOAuthStore } from '../src/oauth/oauth-store.js';
import { createSqliteTaskStore } from '../src/store/sqlite-store.js';
import type { ICodexRpcClient, InitializeResultSummary } from '../src/types.js';

function createIdleRpc(): ICodexRpcClient {
  const noop = () => () => {};
  const unexpected = () => {
    throw new Error('Unexpected Codex RPC call');
  };
  return {
    start: async (): Promise<InitializeResultSummary> => ({
      userAgent: 'mock/1.0',
      platformFamily: 'windows',
      platformOs: 'windows',
      raw: {},
    }),
    stop: async () => {},
    isRunning: () => false,
    getTransportInfo: () => ({ transport: 'stdio', wsUrl: null, wsTokenEnvVar: null, wsToken: null }),
    request: unexpected,
    notify: () => {},
    respondToServerRequest: () => {},
    rejectServerRequest: () => {},
    onNotification: noop,
    onServerRequest: noop,
    onExit: noop,
  };
}

async function getRemoteAccessToken(remoteUrl: string, publicBaseUrl: string, ownerPassphrase: string) {
  const redirectUri = 'https://gemini.google.com/callback';
  const regRes = await fetch(`${remoteUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Gemini Remote Test',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(regRes.status, 201);
  const { client_id: clientId } = (await regRes.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const resource = `${publicBaseUrl}/mcp/remote`;

  const authGet = await fetch(
    `${remoteUrl}/oauth/authorize?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        resource,
        state: 'st-proj-reg',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })
  );
  assert.equal(authGet.status, 200);
  const html = await authGet.text();
  const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const cookie = authGet.headers.get('set-cookie')?.split(';')[0];
  assert.ok(csrf && cookie);

  const authPost = await fetch(`${remoteUrl}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
    body: new URLSearchParams({ csrf_token: csrf, passphrase: ownerPassphrase, decision: 'approve' }),
  });
  assert.equal(authPost.status, 302);
  const code = new URL(authPost.headers.get('location')!).searchParams.get('code')!;
  assert.ok(code);

  const tokenRes = await fetch(`${remoteUrl}/oauth/token`, {
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
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

test('local MCP supports project_register/project_remove with hot-reload, persistence, safety guards, and remote exclusion', async (t: TestContext) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'hub-proj-admin-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const initialProj = join(tempRoot, 'initial-proj');
  const newProj = join(tempRoot, 'new-proj');
  await mkdir(initialProj, { recursive: true });
  await mkdir(newProj, { recursive: true });

  const configPath = join(tempRoot, 'hub.json');
  const localToken = 'local-admin-secret-token-123456';
  const publicBaseUrl = 'https://admin-test.tailnet.ts.net';
  const ownerPassphrase = 'strong-owner-passphrase-xyz';

  await writeFile(
    configPath,
    JSON.stringify(
      {
        host: '127.0.0.1',
        port: 4789,
        localToken,
        dbPath: ':memory:',
        remote: {
          enabled: true,
          host: '127.0.0.1',
          port: 4790,
          publicBaseUrl,
          ownerPassphrase,
          allowedRedirectUriPrefixes: ['https://gemini.google.com/'],
        },
        projects: [
          {
            id: 'initial',
            name: 'Initial',
            rootPath: initialProj.replace(/\\/g, '/'),
            permissionMode: 'read_only',
            docsSubdir: 'docs',
          },
        ],
      },
      null,
      2
    ),
    'utf8'
  );

  const config = loadHubConfig({ configPath, env: {} });
  assert.equal(config.configPath, configPath);

  const store = createSqliteTaskStore(':memory:');
  const hub = createHubServer({
    config: {
      ...config,
      port: 0,
      remote: {
        ...config.remote,
        port: 0,
      },
    },
    store,
    oauthStore: new SqliteOAuthStore(':memory:'),
    rpcClient: createIdleRpc(),
  });
  await hub.start();

  const localClient = new Client({ name: 'antigravity-local', version: '1.0.0' });
  const remoteClient = new Client({ name: 'gemini-remote', version: '1.0.0' });
  t.after(async () => {
    await localClient.close().catch(() => undefined);
    await remoteClient.close().catch(() => undefined);
    await hub.stop();
  });

  await localClient.connect(
    new StreamableHTTPClientTransport(new URL(hub.mcpLocalUrl), {
      requestInit: { headers: { Authorization: `Bearer ${localToken}` } },
    })
  );

  const remoteToken = await getRemoteAccessToken(hub.remoteUrl!, publicBaseUrl, ownerPassphrase);
  await remoteClient.connect(
    new StreamableHTTPClientTransport(new URL(hub.remoteMcpUrl!), {
      requestInit: { headers: { Authorization: `Bearer ${remoteToken}` } },
    })
  );

  // 1. Local exposes project_register & project_remove; remote MUST NOT expose either
  const localTools = (await localClient.listTools()).tools.map((tool) => tool.name);
  assert.ok(localTools.includes('project_register'));
  assert.ok(localTools.includes('project_remove'));

  const remoteTools = (await remoteClient.listTools()).tools.map((tool) => tool.name);
  assert.equal(remoteTools.includes('project_register'), false);
  assert.equal(remoteTools.includes('project_remove'), false);

  // 2. Register new project -> hot-reloaded in MCP project_list & REST /api/projects + persisted
  const regRes = CallToolResultSchema.parse(
    await localClient.callTool({
      name: 'project_register',
      arguments: {
        id: 'sample-app',
        name: 'Sample App',
        rootPath: newProj,
        permissionMode: 'codex_work',
        description: 'Added dynamically',
      },
    })
  );
  assert.equal(regRes.isError, undefined);
  const regBody = JSON.parse(regRes.content[0]?.type === 'text' ? regRes.content[0].text : '{}') as {
    ok: boolean;
    created: boolean;
    persisted: boolean;
    project: { id: string; permissionMode: string };
  };
  assert.equal(regBody.ok, true);
  assert.equal(regBody.created, true);
  assert.equal(regBody.persisted, true);
  assert.equal(regBody.project.id, 'sample-app');
  assert.equal(regBody.project.permissionMode, 'codex_work');

  const listAfter = CallToolResultSchema.parse(await localClient.callTool({ name: 'project_list', arguments: {} }));
  const listed = JSON.parse(listAfter.content[0]?.type === 'text' ? listAfter.content[0].text : '{}') as {
    projects: Array<{ id: string }>;
  };
  assert.ok(listed.projects.some((p) => p.id === 'sample-app'));

  const restProj = (await (await fetch(`${hub.url}/api/projects`)).json()) as {
    projects: Array<{ id: string }>;
  };
  assert.ok(restProj.projects.some((p) => p.id === 'sample-app'));

  const persistedJson = JSON.parse(await readFile(configPath, 'utf8')) as {
    localToken: string;
    remote: { ownerPassphrase: string };
    projects: Array<{ id: string; permissionMode: string }>;
  };
  assert.equal(persistedJson.localToken, localToken);
  assert.equal(persistedJson.remote.ownerPassphrase, ownerPassphrase);
  assert.ok(persistedJson.projects.some((p) => p.id === 'sample-app' && p.permissionMode === 'codex_work'));

  // 3. Duplicate ID rejected when overwrite=false, allowed when overwrite=true
  const dupFail = CallToolResultSchema.parse(
    await localClient.callTool({
      name: 'project_register',
      arguments: { id: 'sample-app', name: 'Sample App 2', rootPath: newProj },
    })
  );
  assert.equal(dupFail.isError, true);

  const dupOk = CallToolResultSchema.parse(
    await localClient.callTool({
      name: 'project_register',
      arguments: {
        id: 'sample-app',
        name: 'Sample App Updated',
        rootPath: newProj,
        permissionMode: 'docs_write',
        overwrite: true,
      },
    })
  );
  assert.equal(dupOk.isError, undefined);
  const dupBody = JSON.parse(dupOk.content[0]?.type === 'text' ? dupOk.content[0].text : '{}') as {
    created: boolean;
    project: { name: string; permissionMode: string };
  };
  assert.equal(dupBody.created, false);
  assert.equal(dupBody.project.name, 'Sample App Updated');
  assert.equal(dupBody.project.permissionMode, 'docs_write');

  // 4. Dangerous/nonexistent rootPath rejected
  const fsRoot = parse(newProj).root;
  const homeDir = homedir();
  const codexDir = join(homeDir, '.codex');
  for (const badPath of [fsRoot, homeDir, codexDir, join(tempRoot, 'does-not-exist')]) {
    const badRes = CallToolResultSchema.parse(
      await localClient.callTool({
        name: 'project_register',
        arguments: { id: 'bad-proj', name: 'Bad', rootPath: badPath },
      })
    );
    assert.equal(badRes.isError, true, `Expected rejection for rootPath=${badPath}`);
  }

  // Audit logs recorded
  const logs = store.listAuditLogs(20);
  assert.ok(logs.some((l) => l.action === 'project_registered' && l.projectId === 'sample-app'));

  // 5. Remove project removes from sandbox and persisted config
  const rmRes = CallToolResultSchema.parse(
    await localClient.callTool({ name: 'project_remove', arguments: { projectId: 'sample-app' } })
  );
  assert.equal(rmRes.isError, undefined);
  const rmBody = JSON.parse(rmRes.content[0]?.type === 'text' ? rmRes.content[0].text : '{}') as {
    removed: boolean;
  };
  assert.equal(rmBody.removed, true);

  const afterRemoveJson = JSON.parse(await readFile(configPath, 'utf8')) as {
    projects: Array<{ id: string }>;
  };
  assert.equal(afterRemoveJson.projects.some((p) => p.id === 'sample-app'), false);
  assert.ok(store.listAuditLogs(20).some((l) => l.action === 'project_removed' && l.projectId === 'sample-app'));
});
