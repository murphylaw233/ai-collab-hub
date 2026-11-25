# AI Collab Hub — Technical Design Specification

## 1. Goals & Operating Principles
`ai-collab-hub` is a local Windows-native collaboration bridge enabling **Antigravity** (Desktop & Remote Control PWA) and **Gemini App** (Web & Mobile via Connected Apps) to inspect authorized local projects and orchestrate **OpenAI Codex** tasks without manual copy-pasting.

- **Single Shared Infrastructure**: Both clients share the same core Hub daemon, SQLite task/audit store, security boundaries, and Worker adapters.
- **No Fragile Scraping/Cookies**: Only official, documented protocols (`codex app-server`, Streamable HTTP MCP, OAuth 2.1, Antigravity Plugin system).
- **Pure Windows Native**: Runs directly on Windows (Node.js 24+, no WSL required), avoiding cross-filesystem `/mnt/c` overhead.

---

## 2. Technology Stack
- **Runtime**: Node.js 24+ (TypeScript, ESM).
- **Persistence**: Built-in `node:sqlite` (`DatabaseSync`, zero native C++ build toolchain required).
- **MCP Server**: `@modelcontextprotocol/sdk` using Streamable HTTP (`/mcp`).
- **Codex Worker**: `@openai/codex` (`codex-cli 0.172.0`) via `codex app-server` JSON-RPC. Phase 1 verified that `ws://127.0.0.1:<port>` (`--ws-auth capability-token --ws-token-file <file>`) supports **concurrent multi-client connections** alongside ChatGPT subscription auth (`%USERPROFILE%\.codex\auth.json`), so `codex.transport` defaults to `'ws'` with `'stdio'` fallback supported.
- **Remote Exposure (Phase 2)**: Zero-server HTTPS via **Tailscale Funnel** (`*.ts.net`) + built-in **OAuth 2.1** authorization server (PKCE, RFC 9728 / 8414 / 7591 DCR + static client fallback, `state` parameter limit ≥ 4096 chars).

---

## 3. Real-Time Observability & Live Work Monitor

Rather than brittle PTY scraping or terminal emulation, observability is built natively on `codex app-server` structured events:

1. **Why `codex app-server` instead of `codex exec --json`**:
   - `codex app-server` is a strict superset of `exec --json`: it streams plan updates (`turn/plan/updated`), reasoning summaries (`item/reasoning/summaryTextDelta`), command execution output deltas (`item/commandExecution/outputDelta`), file patches (`item/fileChange/patchUpdated`, `turn/diff/updated`), agent messages (`item/agentMessage/delta`), warnings/errors, and token usage (`thread/tokenUsage/updated`), while also supporting mid-turn steering (`turn/steer`), interruption (`turn/interrupt`), and interactive server-initiated approval requests (`ServerRequest`).
   - Maintaining a second `codex exec --json` runner would duplicate lifecycle logic with weaker control.
2. **Event Pipeline (`app-server` → SQLite → SSE → Local Web Console)**:
   - Hub subscribes to `ServerNotification` and `ServerRequest`, normalizes events, coalesces high-frequency text/command deltas in memory (~100 ms intervals) and truncates oversized command output (`maxCommandOutputBytes`), then persists ordered `(task_id, seq)` rows to SQLite `task_events`.
   - The Local Web Console (`http://127.0.0.1:<port>/ui`) fetches historical events (`GET /api/tasks/:id/events?afterSeq=0`) and attaches an SSE stream (`GET /api/tasks/:id/stream?afterSeq=N`) for live progress, unified diffs, and desktop L2 approvals.
3. **Persistent Sessions & Native TUI Takeover**:
   - Threads default to `ephemeral: false` and persist `threadId` in SQLite.
   - Operators can inspect or take over any thread via `codex resume <threadId>`, or attach a live TUI observer via `codex --remote ws://127.0.0.1:<port> --remote-auth-token-env <VAR>` (verified compatible in Phase 1 `ws://` multi-client probe).
4. **Protocol-Enforced Structured Codex Reports**:
   - `turn/start` passes `outputSchema: CODEX_REPORT_OUTPUT_SCHEMA` so Codex's final message conforms at the protocol level to `verdict` (`completed | plan_concern | blocked`), `summary`, `risks_or_disagreements`, `changed_files`, `verification_output`, and `next_suggested_action`.

---

## 3. Shared Architecture (`Local Collaboration Hub`)

```text
  [Gemini App (Web / Mobile)]                  [Antigravity (Desktop / Remote PWA)]
              │ (HTTPS + OAuth 2.1)                           │ (127.0.0.1 + Bearer)
              ▼                                               │ (+ Plugin: Skill/Rules/Hooks)
     [Tailscale Funnel]                                       │
              │                                               │
              └───────────────────────┬───────────────────────┘
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     ai-collab-hub (Windows Background Hub)                   │
│                                                                              │
│  1. MCP Gateway (Streamable HTTP)                                            │
│     ├─ /mcp/local   (Local Bearer; Codex orchestration + project registry)   │
│     └─ /mcp/remote  (OAuth 2.1; File Sandbox + Codex orchestration)          │
│                                                                              │
│  2. Task Orchestrator & Safety Engine (SQLite)                               │
│     ├─ State machine: QUEUED → RUNNING → WAITING_APPROVAL → COMPLETED/FAILED │
│     ├─ Guardrails: idempotency_key dedupe, per-project write lock, circuit   │
│     │              breaker (max turns, wall-clock timeout, repeated errors)  │
│     └─ Audit log: origin, prompt, diff summary, commands, approvals, timing  │
│                                                                              │
│  3. Execution & Sandbox Layer                                                │
│     ├─ Scoped File Sandbox (allowlist roots, canonical paths, secret block)  │
│     ├─ WorkerAdapter ──▶ CodexAppServerAdapter (persistent codex app-server) │
│     │                ──▶ [Extensible] future CLI/agent adapters              │
│     └─ Desktop Approval & Monitor Web UI (http://127.0.0.1:<port>/ui)        │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Client Profiles & Division of Labor

| Surface | Exposed Tools | Role |
| :--- | :--- | :--- |
| **Antigravity** (`/mcp/local` + Plugin) | `project_list`, `codex_submit`, `codex_status`, `codex_wait`, `codex_followup`, `codex_interrupt`, `codex_diff` | Deep repo exploration, planning, auditing, documentation, orchestrating Codex, final review. |
| **Gemini App** (`/mcp/remote`) | Above Codex tools + guarded File Sandbox (`fs_list_dir`, `fs_search`, `fs_read_lines`, `fs_git_diff`, optional `docs/` write) | Lightweight planning, document drafting, reading specific files directly, delegating heavy repo scans (`readonly_research`) and code changes to Codex. |

### Structured Codex Feedback Contract
Codex is not a blind executor. Prompts injected by the Hub enforce a structured report covering:
- `verdict`: `completed` | `plan_concern` | `blocked`
- `risks_or_disagreements`: technical flaws, edge cases, or plan mistakes discovered by Codex
- `changed_files`: modified paths
- `verification_output`: tests/checks actually run and their results

A `precheck` (read-only) mode allows Codex to validate feasibility and flag plan errors before any file edits occur.

---

## 5. Security, Approval & Anti-Loop Guardrails

1. **Three-Tier Permission Model**:
   - **L0 (Auto-allow)**: Read-only scans, allowlisted test/lint commands inside registered workspaces.
   - **L1 (Scoped write)**: Edits inside registered project roots (isolated branch / worktree in Phase 3).
   - **L2 (Desktop Human-Only Approval)**: Destructive ops, out-of-workspace paths, network/global installs, `git push`. Remote LLMs **cannot** self-approve L2 requests; the task enters `WAITING_APPROVAL` until approved by the user in the local Web UI.
2. **File Sandbox Hardening**:
   - Canonical realpath checks against registered project roots (blocks `..` traversal and symlinks/junctions escaping roots).
   - Hard denylist for secrets (`.env*`, `*.key`, `*.pem`, `~/.codex/auth.json`, `~/.ssh`).
   - Output byte & line limits to prevent context flooding.
3. **Anti-Loop & Cost Protection**:
   - `idempotency_key` + cooldown window to reject duplicate submissions.
   - Per-project write mutex (at most 1 active write turn per repo/worktree).
   - Hard caps on wall-clock runtime, follow-up turns, and consecutive identical failures.

---

## 6. Phased Delivery Roadmap
- **Phase 0 (Current Gate)**: Verify native Windows `@openai/codex` installation, `codex app-server` JSON-RPC handshake, ChatGPT subscription auth reuse, exact protocol schemas, and one read-only `thread/start` + `turn/start` turn.
- **Phase 1**: Unified Hub core (`node:sqlite`, Streamable HTTP `/mcp/local`, `CodexAppServerAdapter`, guardrails, Desktop Approval Web UI) + Antigravity Plugin (`mcp_config.json`, `SKILL.md`, `AGENTS.md`, `hooks.json`).
- **Phase 2**: File Sandbox MCP tools + OAuth 2.1 (`state` ≥ 4096 chars, DCR + static fallback) + Tailscale Funnel `/mcp/remote` + Gemini App Connected Apps integration.
- **Phase 3**: Git worktree isolation per task and additional pluggable Worker Adapters.
