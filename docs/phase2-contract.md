# Phase 2 Contract — Remote Gemini App Gateway (`/mcp/remote` + OAuth 2.1)

## 1. Dual-Port Isolation Model
- **Local Control Plane (`127.0.0.1:3789`, never exposed externally)**:
  - Serves `/ui`, `/api/*` (including L2 desktop human approvals & `/api/oauth/revoke-all`), and `/mcp/local` (static Bearer token).
- **Remote Gemini Gateway (`127.0.0.1:3790`, exposed via `tailscale funnel --bg --https=443 3790`)**:
  - Serves **ONLY** `/.well-known/*`, `/oauth/*`, and `/mcp/remote`.
  - Requests to `/ui`, `/api/*`, or `/mcp/local` on the remote port MUST return `404`.

---

## 2. OAuth 2.1 Server Contract (`src/oauth/oauth-store.ts`, `src/oauth/oauth-server.ts`)

Implements `IOAuthStore` and `IOAuthServer` from `src/types.ts`:

### Endpoints
1. `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp/remote` (RFC 9728):
   ```json
   {
     "resource": "<publicBaseUrl>/mcp/remote",
     "authorization_servers": ["<publicBaseUrl>"],
     "bearer_methods_supported": ["header"],
     "scopes_supported": ["mcp:tools"]
   }
   ```
2. `GET /.well-known/oauth-authorization-server` (RFC 8414):
   - `issuer`: `<publicBaseUrl>`
   - `authorization_endpoint`: `<publicBaseUrl>/oauth/authorize`
   - `token_endpoint`: `<publicBaseUrl>/oauth/token`
   - `registration_endpoint`: `<publicBaseUrl>/oauth/register`
   - `revocation_endpoint`: `<publicBaseUrl>/oauth/revoke`
   - `response_types_supported`: `["code"]`
   - `grant_types_supported`: `["authorization_code", "refresh_token"]`
   - `code_challenge_methods_supported`: `["S256"]`
   - `token_endpoint_auth_methods_supported`: `["none", "client_secret_post", "client_secret_basic"]`
   - `scopes_supported`: `["mcp:tools"]`
3. `POST /oauth/register` (RFC 7591 Dynamic Client Registration):
   - Validates `redirect_uris` against `remote.allowedRedirectUriPrefixes`.
   - Supports `"none"`, `"client_secret_post"`, and `"client_secret_basic"`; hashes issued `client_secret` with SHA-256 before storing in SQLite.
4. `GET /oauth/authorize` & `POST /oauth/authorize`:
   - Validates registered `client_id`, exact `redirect_uri` match, `response_type === "code"`, `code_challenge_method === "S256"`, non-empty `code_challenge`, and opaque `state` with length `<= remote.maxStateLength` (minimum `4096`, default `16384`) — **must echo `state` back verbatim without alteration**.
   - Renders a self-contained dark consent HTML form (no external CDN, strict `textContent`/escaping, CSRF hidden token).
   - `POST /oauth/authorize` verifies CSRF token, per-IP brute-force rate limiter (e.g., max 5 failed attempts per 15 minutes → `429`), and constant-time comparison against `remote.ownerPassphrase`. On Approve, stores hashed single-use auth code (`expiresAt = now + 5m`) and redirects `302` to `redirect_uri` with `code` + verbatim `state`. On Deny, redirects with `error=access_denied` + verbatim `state`.
5. `POST /oauth/token`:
   - Supports `application/x-www-form-urlencoded` and `application/json`.
   - `grant_type=authorization_code`: verifies client auth if confidential, atomically consumes auth code (`usedAt IS NULL`), verifies `redirect_uri`, verifies PKCE `BASE64URL(SHA256(code_verifier)) === code_challenge`, issues access token (`accessTokenTtlSec`) + refresh token (`refreshTokenTtlSec`), storing only SHA-256 hashes in SQLite.
   - `grant_type=refresh_token`: atomically rotates refresh token via `rotateRefreshToken(...)` and issues fresh access/refresh pair.
6. `POST /oauth/revoke` (RFC 7009): revokes access or refresh token hash and returns `200`.

### Unauthorized `/mcp/remote` Challenge
- Missing or invalid `Authorization: Bearer <token>` on `/mcp/remote` returns HTTP `401` with:
  `WWW-Authenticate: Bearer resource_metadata="<publicBaseUrl>/.well-known/oauth-protected-resource/mcp/remote"`

---

## 3. Remote MCP Server Contract (`src/mcp/remote-mcp-server.ts`)
- Stateless Streamable HTTP (`StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`) at `/mcp/remote`.
- Authenticates every request via `oauthServer.verifyAccessToken(req.headers.authorization)`.
- Registers:
  1. Shared Codex tools via `registerCodexTools(server, taskManager, sandbox, 'gemini_app', getMonitorUrl())` (`project_list`, `codex_submit`, `codex_wait`, `codex_status`, `codex_result`, `codex_followup`, `codex_interrupt`, `codex_list_tasks`).
  2. Guarded File Sandbox tools via `registerFileSandboxTools(server, sandbox, store, 'gemini_app', allowRemoteDocsWrite)`:
     - `fs_list_dir({ projectId, relativePath?, maxDepth?, maxEntries? })`
     - `fs_read_lines({ projectId, relativePath, startLine?, endLine?, maxBytes? })`
     - `fs_search({ projectId, query, relativePath?, maxMatches?, caseSensitive? })`
     - `fs_git_diff({ projectId, maxDiffBytes?, includeUntracked? })`
     - `fs_write_doc({ projectId, relativePath, content, overwrite? })` — **registered ONLY when `allowRemoteDocsWrite === true`**.
- Records an audit entry in `store.appendAuditLog` with `origin: 'gemini_app'` on File Sandbox tool calls.
- **Never** exposes L2 approval decision tools on MCP.
