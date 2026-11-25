# AI Collab Hub — Antigravity ↔ Codex Division of Labor

When working with the `ai-collab-hub` MCP server:

1. **Clear Role Split**:
   - **Antigravity** owns architecture, multi-file exploration, auditing, design docs, final review, and user communication.
   - **Codex** owns scoped code edits, refactoring, script/test writing, and bounded batch scans (`readonly_research`).
2. **Precheck Before Risky Edits**:
   - For ambiguous or cross-cutting changes, submit a `precheck` task first so Codex inspects the codebase and flags flaws (`verdict: "plan_concern"` or `"blocked"`) before any edits happen.
3. **Respect Codex Feedback**:
   - Never ignore `risks_or_disagreements` or a `plan_concern` / `blocked` verdict; adjust the plan or ask the user before proceeding.
4. **Human-Only L2 Approvals**:
   - If `codex_wait` returns `WAITING_APPROVAL`, do NOT work around the approval. Direct the user to the `monitorUrl` (`http://127.0.0.1:3789/ui`) to review and approve/decline the L2 request.
5. **Preserve Traceability**:
   - Share `resumeCommand` (`codex resume <threadId>`) and `monitorUrl` when reporting long or paused tasks so the user can inspect or take over at any time.
6. **Concise User-Facing Reporting**:
   - Synthesize Codex task updates and completion results into concise, human-readable summaries (verdict, changed files, verification outcomes, and next actions); never dump raw internal notification wrappers, raw event JSON payloads, or full command logs directly to the user unless explicitly requested.
7. **Rigorous Codex Prompts & Context Hygiene**:
   - Write clear, owner-authorized, evidence-driven prompts that authorize end-to-end tracing and self-debugging while forbidding redundant defensive boilerplate, unrelated refactors, or speculative refusals; check `contextUsage.pressure` before `codex_followup` and open a fresh `codex_submit` task when `high` or `critical`.
8. **Quota-Conscious Routing & Zero-Token Waiting**:
   - Use the `collab-orchestrator` skill at the start of substantial work to decide whether Antigravity should hand off iterative/heavy execution to **Gemini App → Codex** (preserving Antigravity's 5-hour quota) or drive Codex directly.
   - When Antigravity waits on Codex tasks, NEVER loop MCP `codex_wait` or pair it with `schedule` timers; launch ONE background `run_command` calling `hub-wait-done.mjs` (SSE-based, supports single or multiple `taskId`s) and stop calling tools until it wakes you.
9. **Local Project Registration**:
   - Antigravity may register or remove authorized local workspace directories via local-only `project_register` / `project_remove` (persisted to `config/hub.json` and hot-reloaded without restarting the Hub; never exposed on remote MCP).
