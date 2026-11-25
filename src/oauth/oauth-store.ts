import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { IOAuthStore, OAuthAuthCodeRecord, OAuthClientRecord, OAuthTokenRecord } from '../types.js';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT NOT NULL PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_secret_hash TEXT CHECK (
      length(client_secret_hash) = 64 AND length(CAST(client_secret_hash AS BLOB)) = 64
        AND client_secret_hash NOT GLOB '*[^0-9a-f]*'
    ),
    redirect_uris TEXT NOT NULL,
    token_endpoint_auth_method TEXT NOT NULL,
    is_static INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code_hash TEXT NOT NULL PRIMARY KEY CHECK (
      length(code_hash) = 64 AND length(CAST(code_hash AS BLOB)) = 64 AND code_hash NOT GLOB '*[^0-9a-f]*'
    ),
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx ON oauth_auth_codes (expires_at);

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id TEXT NOT NULL PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
    scope TEXT NOT NULL,
    resource TEXT,
    access_token_hash TEXT NOT NULL UNIQUE CHECK (
      length(access_token_hash) = 64 AND length(CAST(access_token_hash AS BLOB)) = 64
        AND access_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    refresh_token_hash TEXT UNIQUE CHECK (
      length(refresh_token_hash) = 64 AND length(CAST(refresh_token_hash AS BLOB)) = 64
        AND refresh_token_hash NOT GLOB '*[^0-9a-f]*'
    ),
    access_expires_at INTEGER NOT NULL,
    refresh_expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS oauth_tokens_access_expiry_idx ON oauth_tokens (access_expires_at);
  CREATE INDEX IF NOT EXISTS oauth_tokens_active_expiry_idx ON oauth_tokens (access_expires_at)
    WHERE revoked_at IS NULL;
`;

const CLIENT_COLUMNS = `
  client_id AS clientId, client_name AS clientName, client_secret_hash AS clientSecretHash,
  redirect_uris AS redirectUris, token_endpoint_auth_method AS tokenEndpointAuthMethod,
  is_static AS isStatic, created_at AS createdAt
`;
const TOKEN_COLUMNS = `
  id, client_id AS clientId, scope, resource, access_token_hash AS accessTokenHash,
  refresh_token_hash AS refreshTokenHash, access_expires_at AS accessExpiresAt,
  refresh_expires_at AS refreshExpiresAt, revoked_at AS revokedAt, created_at AS createdAt
`;

type Row = Record<string, SQLOutputValue>;
type NewToken = Parameters<IOAuthStore['createToken']>[0];

function readClient(row: Row): OAuthClientRecord {
  const { redirectUris, isStatic, ...client } = row as Omit<OAuthClientRecord, 'redirectUris' | 'isStatic'> & {
    redirectUris: string;
    isStatic: number;
  };
  return { ...client, redirectUris: JSON.parse(redirectUris) as string[], isStatic: isStatic === 1 };
}

function readAuthCode(row: Row): OAuthAuthCodeRecord {
  return {
    codeHash: row.code_hash as string,
    clientId: row.client_id as string,
    redirectUri: row.redirect_uri as string,
    codeChallenge: row.code_challenge as string,
    codeChallengeMethod: row.code_challenge_method as 'S256',
    scope: row.scope as string,
    resource: row.resource as string | null,
    expiresAt: row.expires_at as number,
    usedAt: row.used_at as number | null,
    createdAt: row.created_at as number,
  };
}

export class InvalidRefreshTokenError extends Error {}

export class SqliteOAuthStore implements IOAuthStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (dbPath !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec(SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  upsertClient(client: Omit<OAuthClientRecord, 'createdAt'>): OAuthClientRecord {
    const row = this.db.prepare(`
      INSERT INTO oauth_clients (
        client_id, client_name, client_secret_hash, redirect_uris, token_endpoint_auth_method, is_static, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (client_id) DO UPDATE SET
        client_name = excluded.client_name,
        client_secret_hash = excluded.client_secret_hash,
        redirect_uris = excluded.redirect_uris,
        token_endpoint_auth_method = excluded.token_endpoint_auth_method,
        is_static = excluded.is_static
      RETURNING ${CLIENT_COLUMNS}
    `).get(
      client.clientId, client.clientName, client.clientSecretHash, JSON.stringify(client.redirectUris),
      client.tokenEndpointAuthMethod, client.isStatic ? 1 : 0, Date.now(),
    );
    return readClient(row!);
  }

  getClient(clientId: string): OAuthClientRecord | null {
    const row = this.db.prepare(`SELECT ${CLIENT_COLUMNS} FROM oauth_clients WHERE client_id = ?`).get(clientId);
    return row ? readClient(row) : null;
  }

  createAuthCode(record: Omit<OAuthAuthCodeRecord, 'usedAt' | 'createdAt'>): OAuthAuthCodeRecord {
    const row = this.db.prepare(`
      INSERT INTO oauth_auth_codes (
        code_hash, client_id, redirect_uri, code_challenge, code_challenge_method, scope, resource, expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(
      record.codeHash, record.clientId, record.redirectUri, record.codeChallenge, record.codeChallengeMethod,
      record.scope, record.resource, record.expiresAt, Date.now(),
    );
    return readAuthCode(row!);
  }

  consumeAuthCode(codeHash: string, nowMs = Date.now()): OAuthAuthCodeRecord | null {
    const row = this.db.prepare(`
      UPDATE oauth_auth_codes SET used_at = ?
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
      RETURNING *
    `).get(nowMs, codeHash, nowMs);
    return row ? readAuthCode(row) : null;
  }

  createToken(record: NewToken): OAuthTokenRecord {
    return this.insertToken(record, Date.now());
  }

  private insertToken(record: NewToken, now: number): OAuthTokenRecord {
    const row = this.db.prepare(`
      INSERT INTO oauth_tokens (
        id, client_id, scope, resource, access_token_hash, refresh_token_hash,
        access_expires_at, refresh_expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING ${TOKEN_COLUMNS}
    `).get(
      record.id, record.clientId, record.scope, record.resource, record.accessTokenHash, record.refreshTokenHash,
      record.accessExpiresAt, record.refreshExpiresAt, now,
    );
    return row as unknown as OAuthTokenRecord;
  }

  getTokenByAccessHash(accessTokenHash: string): OAuthTokenRecord | null {
    const row = this.db.prepare(`SELECT ${TOKEN_COLUMNS} FROM oauth_tokens WHERE access_token_hash = ?`)
      .get(accessTokenHash);
    return row ? row as unknown as OAuthTokenRecord : null;
  }

  getTokenByRefreshHash(refreshTokenHash: string): OAuthTokenRecord | null {
    const row = this.db.prepare(`SELECT ${TOKEN_COLUMNS} FROM oauth_tokens WHERE refresh_token_hash = ?`)
      .get(refreshTokenHash);
    return row ? row as unknown as OAuthTokenRecord : null;
  }

  rotateRefreshToken({ oldTokenId, newToken }: Parameters<IOAuthStore['rotateRefreshToken']>[0]): OAuthTokenRecord {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const { changes } = this.db.prepare(`
        UPDATE oauth_tokens SET revoked_at = ?
        WHERE id = ? AND client_id = ? AND revoked_at IS NULL
          AND refresh_token_hash IS NOT NULL AND refresh_expires_at > ?
      `).run(now, oldTokenId, newToken.clientId, now);
      if (!changes) throw new InvalidRefreshTokenError('Refresh token is inactive');
      const token = this.insertToken(newToken, now);
      this.db.exec('COMMIT');
      return token;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  revokeTokenByHash(tokenHash: string): boolean {
    const { changes } = this.db.prepare(`
      UPDATE oauth_tokens SET revoked_at = ?
      WHERE (access_token_hash = ? OR refresh_token_hash = ?) AND revoked_at IS NULL
    `).run(Date.now(), tokenHash, tokenHash);
    return Number(changes) > 0;
  }

  revokeAllTokens(): number {
    return Number(this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE revoked_at IS NULL')
      .run(Date.now()).changes);
  }

  countActiveTokens(nowMs = Date.now()): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM oauth_tokens WHERE revoked_at IS NULL AND access_expires_at > ?
    `).get(nowMs);
    return Number(row!.count);
  }

  purgeExpired(nowMs = Date.now()): number {
    const codes = this.db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at <= ?').run(nowMs);
    const tokens = this.db.prepare(`
      DELETE FROM oauth_tokens
      WHERE access_expires_at <= ? AND (refresh_expires_at IS NULL OR refresh_expires_at <= ?)
    `).run(nowMs, nowMs);
    return Number(codes.changes) + Number(tokens.changes);
  }
}

export function createSqliteOAuthStore(dbPath: string): SqliteOAuthStore {
  return new SqliteOAuthStore(dbPath);
}
