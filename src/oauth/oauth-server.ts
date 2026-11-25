import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  IOAuthServer, IOAuthStore, OAuthClientRecord, RemoteGatewayConfig, VerifiedAccessToken,
} from '../types.js';
import { InvalidRefreshTokenError } from './oauth-store.js';

const RESOURCE_METADATA = '/.well-known/oauth-protected-resource';
const RESOURCE_PATH = '/mcp/remote';
const AUTHORIZE_PATH = '/oauth/authorize';
const SCOPE = 'mcp:tools';
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;
const CONSENT_TTL_MS = 5 * 60_000;
const LOCKOUT_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const MAX_PENDING_CONSENTS = 512;
const MAX_BODY_BYTES = 64 * 1024;
const CSRF_COOKIE = 'oauth_consent';

type Fields = Record<string, unknown>;
type Consent = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  resource: string | null;
  expiresAt: number;
};
type FailureWindow = { count: number; expiresAt: number };

class OAuthRequestError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function opaqueSecret(): string {
  return randomBytes(32).toString('base64url');
}

function parseWebUrl(value: string): URL | null {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(value)?.[1];
  if (!authority || authority.includes('@') || /[\s\\#\x00-\x1f\x7f]/.test(value)) return null;
  const parsed = URL.parse(value);
  if (!parsed || /%(?:2f|5c|25)/i.test(parsed.pathname)) return null;
  return parsed;
}

function allowedRedirect(uri: string, prefixes: readonly string[]): boolean {
  const redirect = parseWebUrl(uri);
  if (!redirect) return false;
  return prefixes.some(prefix => {
    const loopback = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):$/i.exec(prefix);
    if (loopback) {
      return redirect.protocol === 'http:' && redirect.hostname === loopback[1].toLowerCase()
        && /^http:\/\/[^/?]+:\d+(?:[/?]|$)/i.test(uri);
    }
    const allowed = parseWebUrl(prefix);
    if (!allowed || redirect.origin !== allowed.origin) return false;
    const pathPrefix = allowed.pathname.endsWith('/') ? allowed.pathname : allowed.pathname + '/';
    return (redirect.pathname === allowed.pathname || redirect.pathname.startsWith(pathPrefix))
      && (!allowed.search || redirect.search === allowed.search || redirect.search.startsWith(allowed.search + '&'));
  });
}

function formFields(params: URLSearchParams): Fields {
  const fields: Fields = Object.create(null);
  for (const [name, value] of params) {
    if (Object.hasOwn(fields, name)) throw new OAuthRequestError('invalid_request');
    fields[name] = value;
  }
  return fields;
}

function optionalString(fields: Fields, name: string): string | undefined {
  if (!Object.hasOwn(fields, name)) return undefined;
  const value = fields[name];
  if (typeof value !== 'string') throw new OAuthRequestError('invalid_request');
  return value;
}

function requiredString(fields: Fields, name: string): string {
  const value = optionalString(fields, name);
  if (!value) throw new OAuthRequestError('invalid_request');
  return value;
}

async function readBody(req: IncomingMessage, jsonOnly = false): Promise<Fields> {
  const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && (jsonOnly || type !== 'application/x-www-form-urlencoded')) {
    req.resume();
    throw new OAuthRequestError('invalid_request');
  }
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    byteCount += chunk.length;
    if (byteCount > MAX_BODY_BYTES) {
      req.resume();
      throw new OAuthRequestError('invalid_request', 413);
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (type === 'application/x-www-form-urlencoded') return formFields(new URLSearchParams(body));
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Fields;
  } catch {
    throw new OAuthRequestError('invalid_request');
  }
  throw new OAuthRequestError('invalid_request');
}

function sendJson(res: ServerResponse, status: number, body: Fields): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  }).end(JSON.stringify(body));
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, character => entities[character]);
}

function renderConsent(
  res: ServerResponse, clientName: string, csrf: string, failed = false,
): void {
  res.writeHead(failed ? 401 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }).end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize access</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #11151c; color: #ecf1f8; }
    main { max-width: 30rem; margin: 12vh auto; padding: 1.5rem; overflow-wrap: anywhere; }
    label, input { display: block; }
    input, button { font: inherit; padding: .55rem; margin: .4rem .4rem .4rem 0; }
    [role=alert] { color: #ffb4ab; }
  </style>
</head>
<body><main>
  <h1>Authorize access</h1>
  <p><strong>${escapeHtml(clientName)}</strong> is requesting access to MCP tools.</p>
  ${failed ? '<p role="alert">Incorrect owner passphrase.</p>' : ''}
  <form method="post" action="authorize">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}">
    <label for="passphrase">Owner passphrase</label>
    <input id="passphrase" name="passphrase" type="password" required>
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</main></body>
</html>`);
}

function redirectWithResult(res: ServerResponse, consent: Consent, result: Record<string, string>): void {
  const params = new URLSearchParams(result);
  if (consent.state !== undefined) params.set('state', consent.state);
  // Keep the registered query string intact and encode the response values independently.
  const location = new URL(consent.redirectUri).href;
  const separator = location.includes('?') ? '&' : '?';
  res.writeHead(302, {
    Location: location + separator + params,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  }).end();
}

export class OAuthServer implements IOAuthServer {
  private readonly publicBaseUrl: string;
  private readonly resource: string;
  private readonly cookieAttributes: string;
  private readonly passphraseHash: Buffer | undefined;
  private readonly pending = new Map<string, Consent>();
  private readonly failures = new Map<string, FailureWindow>();
  private nextSweepAt = 0;

  constructor(private readonly store: IOAuthStore, private readonly config: RemoteGatewayConfig) {
    const configuredBase = config.publicBaseUrl ?? (config.enabled ? '' : `http://127.0.0.1:${config.port}`);
    const base = parseWebUrl(configuredBase);
    if (!base || configuredBase.includes('?')) throw new Error('Invalid OAuth public base URL');
    this.publicBaseUrl = base.href.replace(/\/+$/, '');
    this.resource = this.publicBaseUrl + RESOURCE_PATH;
    this.cookieAttributes = `Path=${base.pathname.replace(/\/+$/, '') + AUTHORIZE_PATH}; HttpOnly; SameSite=Lax`
      + (base.protocol === 'https:' ? '; Secure' : '');
    this.passphraseHash = config.ownerPassphrase ? hash(config.ownerPassphrase) : undefined;

    const client = config.staticClient;
    if (client) {
      const clientSecretHash = client.clientSecret === undefined ? null : hash(client.clientSecret).toString('hex');
      this.store.upsertClient({
        clientId: client.clientId, clientName: client.clientId, clientSecretHash, redirectUris: client.redirectUris,
        tokenEndpointAuthMethod: clientSecretHash === null ? 'none' : 'client_secret_basic', isStatic: true,
      });
    }
  }

  async handleHttpRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const { method } = req;
    const path = url.pathname;
    try {
      if (method === 'GET' && (path === RESOURCE_METADATA || path === RESOURCE_METADATA + RESOURCE_PATH)) {
        sendJson(res, 200, {
          resource: this.resource, authorization_servers: [this.publicBaseUrl],
          bearer_methods_supported: ['header'], scopes_supported: [SCOPE],
        });
      } else if (
        method === 'GET' &&
        (path === '/.well-known/oauth-authorization-server' ||
          path === '/.well-known/oauth-authorization-server' + RESOURCE_PATH)
      ) {
        sendJson(res, 200, {
          issuer: this.publicBaseUrl,
          authorization_endpoint: this.publicBaseUrl + AUTHORIZE_PATH,
          token_endpoint: this.publicBaseUrl + '/oauth/token',
          registration_endpoint: this.publicBaseUrl + '/oauth/register',
          revocation_endpoint: this.publicBaseUrl + '/oauth/revoke',
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: AUTH_METHODS,
          scopes_supported: [SCOPE],
        });
      } else if (method === 'POST' && path === '/oauth/register') {
        this.register(res, await readBody(req, true));
      } else if (method === 'GET' && path === AUTHORIZE_PATH) {
        this.beginConsent(res, formFields(url.searchParams));
      } else if (method === 'POST' && path === AUTHORIZE_PATH) {
        this.finishConsent(req, res, await readBody(req));
      } else if (method === 'POST' && path === '/oauth/token') {
        this.exchangeToken(req, res, await readBody(req));
      } else if (method === 'POST' && path === '/oauth/revoke') {
        this.revoke(req, res, await readBody(req));
      } else {
        return false;
      }
    } catch (error) {
      if (!(error instanceof OAuthRequestError)) throw error;
      console.warn(`[oauth] ${method} ${path} -> ${error.status} ${error.code}`);
      if (error.status === 401) res.setHeader('WWW-Authenticate', 'Basic realm="OAuth"');
      sendJson(res, error.status, { error: error.code });
    }
    return true;
  }

  verifyAccessToken(authHeader: string | undefined): VerifiedAccessToken | null {
    const tokenValue = /^Bearer +([A-Za-z0-9._~+\/-]+=*)$/i.exec(authHeader ?? '')?.[1];
    if (!tokenValue) return null;
    const token = this.store.getTokenByAccessHash(hash(tokenValue).toString('hex'));
    if (!token || token.revokedAt !== null || token.accessExpiresAt <= Date.now()) return null;
    return {
      tokenId: token.id, clientId: token.clientId, scope: token.scope,
      resource: token.resource, expiresAt: token.accessExpiresAt,
    };
  }

  buildWwwAuthenticateHeader(): string {
    return `Bearer resource_metadata="${this.publicBaseUrl + RESOURCE_METADATA + RESOURCE_PATH}"`;
  }

  revokeAllTokens(): number {
    return this.store.revokeAllTokens();
  }

  countActiveTokens(): number {
    return this.store.countActiveTokens();
  }

  close(): void {
    this.pending.clear();
    this.failures.clear();
    this.store.close();
  }

  private register(res: ServerResponse, fields: Fields): void {
    const redirects = fields.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || !redirects.every(uri =>
      typeof uri === 'string' && allowedRedirect(uri, this.config.allowedRedirectUriPrefixes)
    )) {
      console.warn('[oauth] rejected redirect_uris:', JSON.stringify(redirects));
      throw new OAuthRequestError('invalid_redirect_uri');
    }
    const method = Object.hasOwn(fields, 'token_endpoint_auth_method')
      ? fields.token_endpoint_auth_method
      : 'client_secret_basic';
    if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic') {
      throw new OAuthRequestError('invalid_client_metadata');
    }
    if (Object.hasOwn(fields, 'client_name') && typeof fields.client_name !== 'string') {
      throw new OAuthRequestError('invalid_client_metadata');
    }
    const secret = method === 'none' ? null : opaqueSecret();
    const client = this.store.upsertClient({
      clientId: randomUUID(), clientName: optionalString(fields, 'client_name') || 'OAuth client',
      clientSecretHash: secret === null ? null : hash(secret).toString('hex'),
      redirectUris: redirects, tokenEndpointAuthMethod: method, isStatic: false,
    });
    sendJson(res, 201, {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
    });
  }

  private consentClient(clientId: string, redirectUri: string): OAuthClientRecord {
    const client = this.store.getClient(clientId);
    if (!client || !client.redirectUris.includes(redirectUri) || !parseWebUrl(redirectUri)) {
      throw new OAuthRequestError('invalid_request');
    }
    return client;
  }

  private requestedResource(fields: Fields): string | null {
    const resource = optionalString(fields, 'resource');
    if (resource !== undefined && resource !== this.resource) throw new OAuthRequestError('invalid_target');
    return resource ?? null;
  }

  private beginConsent(res: ServerResponse, fields: Fields): void {
    const clientId = requiredString(fields, 'client_id');
    const redirectUri = requiredString(fields, 'redirect_uri');
    const client = this.consentClient(clientId, redirectUri);
    const state = optionalString(fields, 'state');
    const codeChallenge = requiredString(fields, 'code_challenge');
    if (fields.response_type !== 'code' || fields.code_challenge_method !== 'S256'
      || (state !== undefined && state.length > this.config.maxStateLength)) {
      throw new OAuthRequestError('invalid_request');
    }
    const scope = optionalString(fields, 'scope');
    if (scope && scope !== SCOPE) throw new OAuthRequestError('invalid_scope');
    const resource = this.requestedResource(fields);
    const now = Date.now();
    if (now >= this.nextSweepAt || this.pending.size >= MAX_PENDING_CONSENTS) {
      for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key);
      for (const [key, value] of this.failures) if (value.expiresAt <= now) this.failures.delete(key);
      this.nextSweepAt = now + 60_000;
    }
    if (this.pending.size >= MAX_PENDING_CONSENTS) throw new OAuthRequestError('temporarily_unavailable', 503);
    const csrf = opaqueSecret();
    this.pending.set(csrf, { clientId, redirectUri, codeChallenge, state, resource, expiresAt: now + CONSENT_TTL_MS });
    res.setHeader('Set-Cookie', `${CSRF_COOKIE}=${csrf}; ${this.cookieAttributes}; Max-Age=${CONSENT_TTL_MS / 1000}`);
    renderConsent(res, client.clientName, csrf);
  }

  private finishConsent(req: IncomingMessage, res: ServerResponse, fields: Fields): void {
    const csrf = requiredString(fields, 'csrf_token');
    const cookie = req.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(CSRF_COOKIE + '='))?.slice(CSRF_COOKIE.length + 1);
    const now = Date.now();
    const consent = this.pending.get(csrf);
    const decision = fields.decision;
    if (!consent || consent.expiresAt <= now || cookie !== csrf || (decision !== 'approve' && decision !== 'deny')) {
      throw new OAuthRequestError('invalid_request');
    }
    const client = this.consentClient(consent.clientId, consent.redirectUri);
    // Use the TCP peer unless the gateway has an explicit trusted-proxy policy.
    const ip = req.socket.remoteAddress ?? '';
    const previous = this.failures.get(ip);
    const window = previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + LOCKOUT_MS };
    if (window.count >= MAX_FAILURES) {
      res.setHeader('Retry-After', Math.ceil((window.expiresAt - now) / 1000));
      throw new OAuthRequestError('slow_down', 429);
    }
    const passphrase = optionalString(fields, 'passphrase') ?? '';
    if (!this.passphraseHash || !timingSafeEqual(this.passphraseHash, hash(passphrase))) {
      window.count++;
      this.failures.set(ip, window);
      renderConsent(res, client.clientName, csrf, true);
      return;
    }
    this.failures.delete(ip);
    this.pending.delete(csrf);
    res.setHeader('Set-Cookie', `${CSRF_COOKIE}=; ${this.cookieAttributes}; Max-Age=0`);
    if (decision === 'deny') {
      redirectWithResult(res, consent, { error: 'access_denied' });
      return;
    }
    const code = opaqueSecret();
    this.store.createAuthCode({
      codeHash: hash(code).toString('hex'), clientId: consent.clientId, redirectUri: consent.redirectUri,
      codeChallenge: consent.codeChallenge, codeChallengeMethod: 'S256',
      scope: SCOPE, resource: consent.resource, expiresAt: now + CONSENT_TTL_MS,
    });
    redirectWithResult(res, consent, { code });
  }

  private authenticateClient(req: IncomingMessage, fields: Fields): OAuthClientRecord {
    let clientId = optionalString(fields, 'client_id');
    let secret = optionalString(fields, 'client_secret');
    let method: OAuthClientRecord['tokenEndpointAuthMethod'] = secret === undefined ? 'none' : 'client_secret_post';
    const unauthorized = () => new OAuthRequestError('invalid_client', 401);
    if (req.headers.authorization !== undefined) {
      const basic = /^Basic +([A-Za-z0-9+/]+={0,2})$/i.exec(req.headers.authorization)?.[1];
      if (!basic || secret !== undefined) throw unauthorized();
      const credentials = Buffer.from(basic, 'base64').toString('utf8');
      const separator = credentials.indexOf(':');
      if (separator < 1) throw unauthorized();
      try {
        const basicId = decodeURIComponent(credentials.slice(0, separator).replace(/\+/g, ' '));
        secret = decodeURIComponent(credentials.slice(separator + 1).replace(/\+/g, ' '));
        if (clientId !== undefined && clientId !== basicId) throw unauthorized();
        clientId = basicId;
        method = 'client_secret_basic';
      } catch {
        throw unauthorized();
      }
    }
    const client = clientId ? this.store.getClient(clientId) : null;
    if (!client || client.tokenEndpointAuthMethod !== method) throw unauthorized();
    if (method !== 'none' && (!client.clientSecretHash || secret === undefined
      || !timingSafeEqual(Buffer.from(client.clientSecretHash, 'hex'), hash(secret)))) {
      throw unauthorized();
    }
    return client;
  }

  private exchangeToken(req: IncomingMessage, res: ServerResponse, fields: Fields): void {
    const grant = requiredString(fields, 'grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      throw new OAuthRequestError('unsupported_grant_type');
    }
    const client = this.authenticateClient(req, fields);
    const now = Date.now();
    const requestedResource = this.requestedResource(fields);
    const requestedScope = optionalString(fields, 'scope');
    if (requestedScope && requestedScope !== SCOPE) throw new OAuthRequestError('invalid_scope');
    const invalidGrant = () => new OAuthRequestError('invalid_grant');
    let scope: string;
    let resource: string | null;
    let oldTokenId: string | undefined;
    if (grant === 'authorization_code') {
      const code = requiredString(fields, 'code');
      const redirectUri = requiredString(fields, 'redirect_uri');
      const verifier = optionalString(fields, 'code_verifier');
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalidGrant();
      const record = this.store.consumeAuthCode(hash(code).toString('hex'), now);
      if (!record || record.clientId !== client.clientId || record.redirectUri !== redirectUri
        || record.codeChallenge !== hash(verifier).toString('base64url')) {
        throw invalidGrant();
      }
      scope = record.scope;
      resource = record.resource;
    } else {
      const refreshToken = requiredString(fields, 'refresh_token');
      const record = this.store.getTokenByRefreshHash(hash(refreshToken).toString('hex'));
      if (!record || record.clientId !== client.clientId || record.revokedAt !== null
        || record.refreshExpiresAt === null || record.refreshExpiresAt <= now) {
        throw invalidGrant();
      }
      scope = record.scope;
      resource = record.resource;
      oldTokenId = record.id;
    }
    if (requestedResource !== null && resource !== null && requestedResource !== resource) {
      throw new OAuthRequestError('invalid_target');
    }
    const accessToken = opaqueSecret();
    const refreshToken = opaqueSecret();
    const newToken = {
      id: randomUUID(), clientId: client.clientId, scope, resource: resource ?? requestedResource,
      accessTokenHash: hash(accessToken).toString('hex'), refreshTokenHash: hash(refreshToken).toString('hex'),
      accessExpiresAt: now + this.config.accessTokenTtlSec * 1000,
      refreshExpiresAt: now + this.config.refreshTokenTtlSec * 1000,
    };
    try {
      if (oldTokenId === undefined) this.store.createToken(newToken);
      else this.store.rotateRefreshToken({ oldTokenId, newToken });
    } catch (error) {
      if (error instanceof InvalidRefreshTokenError) throw invalidGrant();
      throw error;
    }
    sendJson(res, 200, {
      access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSec, scope,
    });
  }

  private revoke(req: IncomingMessage, res: ServerResponse, fields: Fields): void {
    const client = this.authenticateClient(req, fields);
    const tokenHash = hash(requiredString(fields, 'token')).toString('hex');
    const token = this.store.getTokenByAccessHash(tokenHash) ?? this.store.getTokenByRefreshHash(tokenHash);
    if (token?.clientId === client.clientId) this.store.revokeTokenByHash(tokenHash);
    res.writeHead(200, { 'Cache-Control': 'no-store' }).end();
  }
}

export function createOAuthServer(options: { store: IOAuthStore; config: RemoteGatewayConfig }): OAuthServer {
  return new OAuthServer(options.store, options.config);
}
