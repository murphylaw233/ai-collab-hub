# AI Collab Hub

Local collaboration bridge that connects **Antigravity** (Desktop & Remote Control PWA) and **Gemini App** (Web & Mobile via Custom Connected Apps) to **OpenAI Codex** (`codex app-server`), with shared SQLite state, guarded project file access, real-time monitoring, and human-only L2 approvals.

> **Platform note (Windows-first):** The core Node.js 24+ server is largely cross-platform, while the bundled autostart/control scripts (`scripts/*.ps1`), PowerShell UTF-8 environment defaults, and process-tree cleanup (`taskkill.exe`) are built for **Windows**. macOS and Linux users can run the core Hub manually via `npm start` / `npm run start:dist`.

## Key Features

- **Dual-Port Isolation (`127.0.0.1:3789` vs `127.0.0.1:3790`)**
  - **Local Control Plane (`3789`)**: Monitor & L2 Approval UI (`/ui`), local REST API (`/api/*`), OAuth emergency kill-switch (`POST /api/oauth/revoke-all`), and local MCP endpoint (`/mcp/local`). Never exposed publicly.
  - **Remote Gateway (`3790`)**: Designed to sit behind **Tailscale Funnel** (`https://<node>.<tailnet>.ts.net`), serving OAuth 2.1 + PKCE `S256` endpoints (`/.well-known/*`, `/oauth/*`, RFC 7591 DCR) and authenticated Streamable HTTP MCP (`/mcp/remote`).
- **Gemini App Connected Apps Ready**
  - Supports Gemini's multi-domain DCR redirect batch (`oauth-redirect`, `oauth-redirect-sandbox`, `oauth-redirect-test`), long `state` tokens, Chromium-compatible consent CSP, bounded 32-bit tool schemas, `<15s` `codex_wait` ceiling + `afterSeq` cursor, coalesced streaming progress, and per-turn follow-up isolation.
- **Antigravity Plugin & Zero-Token SSE Waiter**
  - Includes `plugin/ai-collab-hub/` (`AGENTS.md`, `collab-orchestrator`, `codex-collab`) and `scripts/hub-wait-done.mjs` (zero-dependency SSE watcher with single/multi-task `--mode=all|any`) so Antigravity yields the turn without polling-loop token burn.
  - Supports local-only dynamic `project_register` and `project_remove` (persisted atomically to `config/hub.json` and hot-reloaded without restarting the Hub; excluded from `/mcp/remote`).
- **Human-Only L2 Approvals & Soft-Timeout Protection**
  - Sensitive command/file approvals pause in `WAITING_APPROVAL` and can only be decided in the local Web Console (`http://127.0.0.1:3789/ui`).
  - Exposes `contextUsage.pressure`, sends an 82%-elapsed `turn/steer` wrap-up nudge before hard timeout, and preserves partial buffered diagnostics if a run hits the hard deadline.

## Prerequisites

- **Node.js 24+** (uses built-in `node:sqlite`) and **Git**
- **OpenAI Codex CLI** logged in (`codex login status`)
- *(Optional, for Gemini App remote access)* **Tailscale** with MagicDNS + HTTPS Certificates + Funnel enabled, and a personal Google account (`18+`, **Keep Activity** enabled) with **Connected Apps → Add a custom app** available (note: Gemini Task mode currently requires `@YourCustomApp` in the prompt).

## Quick Start

1. **Install dependencies**
   ```powershell
   npm install
   ```

2. **Bootstrap local config and Antigravity plugin**
   ```powershell
   npm run setup:local
   ```
   This creates `config/hub.json` (if missing) with a generated `localToken`, preserves any existing `config/hub.json`, and installs `plugin/ai-collab-hub/` (plus `scripts/hub-wait-done.mjs`) into `~/.gemini/config/plugins/ai-collab-hub/`.

   Alternatively, copy `config/projects.example.json` to `config/hub.json`, set a strong `localToken` (or `$env:HUB_LOCAL_TOKEN`), and register your authorized projects with `permissionMode`:
   - `read_only`: allows `precheck` and `readonly_research` plus read-only `fs_*` tools
   - `docs_write`: `read_only` plus guarded writes under `docsSubdir` (`fs_write_doc`)
   - `codex_work`: allows `execute` mode edits and tests via Codex

3. **Build and start the Hub**
   ```powershell
   npm run build
   npm start
   ```
   - **Monitor & L2 Approval UI**: `http://127.0.0.1:3789/ui`
   - **Local Streamable HTTP MCP**: `http://127.0.0.1:3789/mcp/local`

## Connect Any MCP Client (`/mcp/local`)

Antigravity users are configured automatically by `npm run setup:local`. Other MCP clients that support Streamable HTTP with Bearer headers (e.g., Claude Desktop, Cursor) can connect directly to `/mcp/local`:

```json
{
  "mcpServers": {
    "ai-collab-hub": {
      "url": "http://127.0.0.1:3789/mcp/local",
      "headers": {
        "Authorization": "Bearer YOUR_HUB_LOCAL_TOKEN"
      }
    }
  }
}
```

## Connect Gemini App (Remote MCP + OAuth 2.1)

See the step-by-step guides (currently in Chinese):
- [docs/gemini-app-setup.md](docs/gemini-app-setup.md) — Tailscale Funnel (`3790` only), `config/hub.json` `"remote"` settings, OAuth 2.1 authorization, and `/api/oauth/revoke-all` emergency revocation.
- [docs/gemini-gem-prompt.md](docs/gemini-gem-prompt.md) — Recommended Gemini Gem instructions for delegating research/execution to local Codex.
- [DESIGN.md](DESIGN.md) — Architecture and design notes.

## Take Over Any Session in Codex TUI

Every task records its persistent `threadId`. Copy `resumeCommand` from the Monitor UI or MCP result:
```powershell
codex resume <threadId>
```

## Windows Autostart (Task Scheduler)

Run `ai-collab-hub` in the background on Windows login without keeping an IDE or terminal open:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
powershell -ExecutionPolicy Bypass -File scripts/hub-ctl.ps1 -Action start
```
Other control commands: `stop`, `restart`, `status`, `logs`. Remove the scheduled task with `scripts/uninstall-autostart.ps1`.

## Development & Verification

```powershell
npm run typecheck
npm run build
npm test
npm run probe:codex:ws
```

To regenerate local Codex app-server protocol TypeScript bindings for reference (gitignored under `docs/codex-protocol/`):
```powershell
npx codex app-server generate-ts --out docs/codex-protocol/ts
```

## License

[MIT](LICENSE)
