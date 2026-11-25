import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadHubConfig } from '../src/config.js';
import { createOAuthServer } from '../src/oauth/oauth-server.js';
import { createSqliteOAuthStore, InvalidRefreshTokenError } from '../src/oauth/oauth-store.js';
import type { RemoteGatewayConfig } from '../src/types.js';

const publicBaseUrl = 'https://hub.example.test';
const ownerPassphrase = 'test-only owner passphrase';
const redirectUri = 'https://client.example.test/callback?flow=original%20value';
const verifier = 'a'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function start(t: TestContext, overrides: Partial<RemoteGatewayConfig> = {}) {
  const store = createSqliteOAuthStore(':memory:');
  const server = createOAuthServer({
    store,
    config: {
      enabled: true, host: '127.0.0.1', port: 3790, publicBaseUrl, ownerPassphrase,
      allowedRedirectUriPrefixes: ['https://client.example.test/callback', 'http://localhost:'],
      accessTokenTtlSec: 3600, refreshTokenTtlSec: 86400, maxStateLength: 4096,
      allowRemoteDocsWrite: false, ...overrides,
    },
  });
  const http = createServer(async (req, res) => {
    try {
      if (!await server.handleHttpRequest(req, res, new URL(req.url!, publicBaseUrl))) {
        res.writeHead(404).end();
      }
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    server.close();
  });
  await once(http, 'listening');
  const address = http.address();
  assert(address && typeof address === 'object');
  const request = (path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, { redirect: 'manual', ...init });
  const post = (
    path: string, fields: Record<string, unknown>, format: 'json' | 'form' = 'form',
    headers?: Record<string, string>,
  ) => request(path, {
    method: 'POST',
    headers: {
      'Content-Type': format === 'json' ? 'application/json' : 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: format === 'json' ? JSON.stringify(fields) : new URLSearchParams(fields as Record<string, string>),
  });
  const register = (fields: Record<string, unknown> = {}) =>
    post('/oauth/register', { redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', ...fields }, 'json');
  const consent = async (clientId: string, extra: Record<string, string> = {}) => {
    const query = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', ...extra,
    });
    const response = await request('/oauth/authorize?' + query);
    assert.equal(response.status, 200);
    const html = await response.text();
    const csrf = html.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    assert(csrf && cookie);
    return {
      html,
      csp: response.headers.get('content-security-policy'),
      submit: (fields: Record<string, string> = {}, sendCookie = true) => post('/oauth/authorize', {
        csrf_token: csrf, passphrase: ownerPassphrase, decision: 'approve', ...fields,
      }, 'form', sendCookie ? { Cookie: cookie } : {}),
    };
  };
  return { store, server, request, post, register, consent };
}

async function expectError(response: Response, status: number, error: string) {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error, error);
}

function getCode(response: Response) {
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location')!);
  const code = location.searchParams.get('code');
  assert(code);
  return code;
}

test('serves protected resource and authorization server metadata', async t => {
  const { request, server } = await start(t);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp/remote']) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: publicBaseUrl + '/mcp/remote', authorization_servers: [publicBaseUrl],
      bearer_methods_supported: ['header'], scopes_supported: ['mcp:tools'],
    });
  }
  const response = await request('/.well-known/oauth-authorization-server');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    issuer: publicBaseUrl,
    authorization_endpoint: publicBaseUrl + '/oauth/authorize',
    token_endpoint: publicBaseUrl + '/oauth/token',
    registration_endpoint: publicBaseUrl + '/oauth/register',
    revocation_endpoint: publicBaseUrl + '/oauth/revoke',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: ['mcp:tools'],
  });
  assert.equal(server.buildWwwAuthenticateHeader(),
    `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource/mcp/remote"`);
  assert.equal((await request('/api/oauth/revoke-all')).status, 404);
});

test('registers allowed redirects and checks origin and path boundaries', async t => {
  const { register, store } = await start(t);
  const redirectUris = [redirectUri, 'https://client.example.test/callback/sub', 'http://localhost:4175/cb'];
  const response = await register({ redirect_uris: redirectUris, token_endpoint_auth_method: 'client_secret_basic' });
  assert.equal(response.status, 201);
  const client = await response.json();
  assert.deepEqual(client.redirect_uris, redirectUris);
  assert.equal(client.token_endpoint_auth_method, 'client_secret_basic');
  assert.equal(store.getClient(client.client_id)?.clientSecretHash, sha256(client.client_secret));
  for (const uri of [
    'https://client.example.test.evil.test/callback', 'https://client.example.test:444/callback',
    'https://client.example.test/callback-other', 'https://client.example.test/callback/../other',
    'https://client.example.test/callback/sub%2f..%2f..%2fother',
    'https://user@client.example.test/callback', 'https://client.example.test/callback#fragment',
    'http://localhost.evil.test:4175/cb', 'http://localhost@evil.test:4175/cb',
  ]) {
    await expectError(await register({ redirect_uris: [uri] }), 400, 'invalid_redirect_uri');
  }
});

test('preserves opaque state through consent and rotates and revokes hashed tokens', async t => {
  const { server, store, register, consent, post } = await start(t);
  const client = await (await register({ client_name: '<script>"&</script>' })).json();
  const clientId = client.client_id as string;
  const state = 'a+% &<"☃漢?'.repeat(400).slice(0, 3000);
  assert.equal(state.length, 3000);
  const form = await consent(clientId, { state, resource: publicBaseUrl + '/mcp/remote' });
  assert(form.html.includes('&lt;script&gt;&quot;&amp;&lt;/script&gt;'));
  assert(!form.html.includes('<script>'));
  assert(form.csp?.includes("default-src 'none'"));
  assert(form.csp?.includes("base-uri 'none'"));
  assert(form.csp?.includes("frame-ancestors 'none'"));
  assert(!form.csp?.includes('form-action'));
  await expectError(await form.submit({}, false), 400, 'invalid_request');
  const approval = await form.submit();
  const code = getCode(approval);
  const location = approval.headers.get('location')!;
  assert(location.startsWith(redirectUri + '&'));
  assert.equal(new URL(location).searchParams.get('state'), state);
  await expectError(await form.submit(), 400, 'invalid_request');

  const grant = {
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier,
  };
  const badCode = getCode(await (await consent(clientId)).submit());
  await expectError(await post('/oauth/token', { ...grant, code: badCode, code_verifier: 'b'.repeat(43) }),
    400, 'invalid_grant');
  const response = await post('/oauth/token', { ...grant, code }, 'json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const tokens = await response.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(tokens.expires_in, 3600);
  const issued = store.getTokenByAccessHash(sha256(tokens.access_token));
  assert(issued);
  assert.equal(issued.refreshTokenHash, sha256(tokens.refresh_token));
  assert.equal(store.getTokenByAccessHash(tokens.access_token), null);
  assert.equal(store.getTokenByRefreshHash(tokens.refresh_token), null);
  assert.deepEqual(server.verifyAccessToken('bearer ' + tokens.access_token), {
    tokenId: issued.id, clientId, scope: 'mcp:tools',
    resource: publicBaseUrl + '/mcp/remote', expiresAt: issued.accessExpiresAt,
  });
  await expectError(await post('/oauth/token', { ...grant, code }), 400, 'invalid_grant');

  const refresh = { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token };
  const rotated = await post('/oauth/token', refresh);
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.notEqual(next.access_token, tokens.access_token);
  assert.equal(server.verifyAccessToken('Bearer ' + tokens.access_token), null);
  await expectError(await post('/oauth/token', refresh), 400, 'invalid_grant');

  const otherClient = await (await register()).json();
  assert.equal((await post('/oauth/revoke', { client_id: otherClient.client_id, token: next.access_token })).status, 200);
  assert(server.verifyAccessToken('Bearer ' + next.access_token));
  assert.equal((await post('/oauth/revoke', { client_id: clientId, token: next.access_token })).status, 200);
  assert.equal(server.verifyAccessToken('Bearer ' + next.access_token), null);
  await expectError(await post('/oauth/token', { ...refresh, refresh_token: next.refresh_token }), 400, 'invalid_grant');
  assert.equal((await post('/oauth/revoke', { client_id: clientId, token: 'unknown' })).status, 200);

  const more = await post('/oauth/token', { ...grant, code: getCode(await (await consent(clientId)).submit()) });
  assert.equal(more.status, 200);
  const active = await more.json();
  assert.equal(server.countActiveTokens(), 1);
  assert.equal(server.revokeAllTokens(), 1);
  assert.equal(server.countActiveTokens(), 0);
  assert.equal(server.verifyAccessToken('Bearer ' + active.access_token), null);
});

test('uses a seeded static confidential client and supports both client secret methods', async t => {
  const staticClient = { clientId: 'preconfigured', clientSecret: 'test-static-secret', redirectUris: [redirectUri] };
  const { consent, post, register, store } = await start(t, {
    staticClient, allowedRedirectUriPrefixes: ['http://localhost:'],
  });
  const client = store.getClient(staticClient.clientId);
  assert(client?.isStatic);
  assert.equal(client.clientSecretHash, sha256(staticClient.clientSecret));
  const code = getCode(await (await consent(staticClient.clientId)).submit());
  const grant = { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier };
  await expectError(await post('/oauth/token', { ...grant, client_id: staticClient.clientId }), 401, 'invalid_client');
  const basic = Buffer.from(staticClient.clientId + ':' + staticClient.clientSecret).toString('base64');
  const basicHeaders = { Authorization: 'Basic ' + basic };
  const response = await post('/oauth/token', grant, 'form', basicHeaders);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal((await post('/oauth/revoke', { token: tokens.refresh_token }, 'form', basicHeaders)).status, 200);
  await expectError(await post('/oauth/token', {
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
  }, 'form', basicHeaders), 400, 'invalid_grant');
  const dynamicRedirect = 'http://localhost:4175/cb';
  const dynamic = await (await register({
    redirect_uris: [dynamicRedirect], token_endpoint_auth_method: 'client_secret_post',
  })).json();
  const dynamicCode = getCode(await (await consent(dynamic.client_id, { redirect_uri: dynamicRedirect })).submit());
  assert.equal((await post('/oauth/token', {
    ...grant, code: dynamicCode, redirect_uri: dynamicRedirect,
    client_id: dynamic.client_id, client_secret: dynamic.client_secret,
  }, 'json')).status, 200);
});

test('rejects invalid authorization parameters and preserves state on denial', async t => {
  const { request, register, consent } = await start(t);
  const client = await (await register()).json();
  const params = {
    client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code',
    code_challenge: challenge, code_challenge_method: 'S256',
  };
  const invalidParams: Array<Record<string, string>> = [
    { client_id: 'unknown' }, { redirect_uri: 'https://client.example.test/callback' },
    { response_type: 'token' }, { code_challenge_method: 'plain' }, { code_challenge: '' },
    { state: 'x'.repeat(4097) },
  ];
  for (const extra of invalidParams) {
    await expectError(await request('/oauth/authorize?' + new URLSearchParams({ ...params, ...extra })),
      400, 'invalid_request');
  }
  const state = '  &+ %<>"漢\r\n';
  const denied = await (await consent(client.client_id, { state })).submit({ decision: 'deny' });
  assert.equal(denied.status, 302);
  const location = new URL(denied.headers.get('location')!);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('state'), state);
});

test('locks out the peer IP after five incorrect owner passphrases', async t => {
  const { register, consent } = await start(t);
  const client = await (await register()).json();
  const form = await consent(client.client_id);
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await form.submit({ passphrase: 'wrong' })).status, 401);
  }
  const locked = await (await consent(client.client_id)).submit();
  assert.equal(locked.status, 429);
  assert(Number(locked.headers.get('retry-after')) > 0);
});

test('rolls back failed rotation and retains refreshable tokens during expiry cleanup', t => {
  const store = createSqliteOAuthStore(':memory:');
  t.after(() => store.close());
  const { clientId } = store.upsertClient({
    clientId: 'store-client', clientName: 'store-client', clientSecretHash: null,
    redirectUris: [redirectUri], tokenEndpointAuthMethod: 'none', isStatic: false,
  });
  const now = Date.now();
  const code = {
    codeHash: sha256('code'), clientId, redirectUri, codeChallenge: challenge,
    codeChallengeMethod: 'S256' as const, scope: 'mcp:tools', resource: null, expiresAt: now,
  };
  store.createAuthCode(code);
  assert.equal(store.consumeAuthCode('code', now - 1), null);
  assert.equal(store.consumeAuthCode(code.codeHash, now), null);
  const token = {
    id: 'old-token', clientId, scope: 'mcp:tools', resource: null,
    accessTokenHash: sha256('access'), refreshTokenHash: sha256('refresh'),
    accessExpiresAt: now, refreshExpiresAt: now + 60_000,
  };
  store.createToken(token);
  assert.equal(store.countActiveTokens(now), 0);
  assert.equal(store.purgeExpired(now), 1);
  assert.throws(() => store.rotateRefreshToken({ oldTokenId: token.id, newToken: token }), /UNIQUE/);
  assert.equal(store.getTokenByRefreshHash(token.refreshTokenHash)?.revokedAt, null);
  const replacement = {
    ...token, id: 'new-token', accessTokenHash: sha256('new access'), refreshTokenHash: sha256('new refresh'),
    accessExpiresAt: now + 60_000,
  };
  assert.equal(store.rotateRefreshToken({ oldTokenId: token.id, newToken: replacement }).id, replacement.id);
  assert.throws(() => store.rotateRefreshToken({ oldTokenId: token.id, newToken: replacement }), InvalidRefreshTokenError);
  assert.equal(store.purgeExpired(now + 60_000), 2);
});

test('supports Gemini multi-domain DCR redirect batch, RFC 8414 path insertion, and empty scope', async t => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'oauth-gemini-cfg-'));
  t.after(() => rmSync(emptyDir, { recursive: true, force: true }));
  const defaults = loadHubConfig({ cwd: emptyDir, env: {} });
  const { request, register, consent } = await start(t, {
    allowedRedirectUriPrefixes: defaults.remote.allowedRedirectUriPrefixes,
  });

  const meta = await request('/.well-known/oauth-authorization-server/mcp/remote');
  assert.equal(meta.status, 200);
  assert.equal((await meta.json()).registration_endpoint, `${publicBaseUrl}/oauth/register`);

  const batchRedirects = [
    'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-123',
    'https://oauth-redirect.googleusercontent.com/a/user_bound_custom-mcp-123',
    'https://oauth-redirect-sandbox.googleusercontent.com/r/user_bound_custom-mcp-123',
    'https://oauth-redirect-sandbox.googleusercontent.com/a/user_bound_custom-mcp-123',
    'https://oauth-redirect-test.googleusercontent.com/r/user_bound_custom-mcp-123',
    'https://oauth-redirect-test.googleusercontent.com/a/user_bound_custom-mcp-123',
  ];
  const regRes = await register({
    client_name: 'Gemini Connected Apps',
    redirect_uris: batchRedirects,
    token_endpoint_auth_method: 'client_secret_basic',
  });
  assert.equal(regRes.status, 201);
  const client = await regRes.json();
  assert.deepEqual(client.redirect_uris, batchRedirects);

  const form = await consent(client.client_id, {
    redirect_uri: batchRedirects[2],
    scope: '',
  });
  assert.ok(form.html.includes('Authorize access'));
  const authRes = await form.submit();
  assert.equal(authRes.status, 302);
});
