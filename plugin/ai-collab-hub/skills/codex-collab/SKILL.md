---
name: codex-collab
description: Orchestrate scoped coding, research, and precheck tasks on local Codex via the ai-collab-hub MCP server.
---

# Codex Collaboration Workflow (`ai-collab-hub`)

Follow this workflow whenever delegating work to local Codex:

1. **Discover (or Register) Authorized Projects**
   - Call `project_list` to verify the target `projectId` and its `permissionMode` (`read_only`, `docs_write`, or `codex_work`).
   - If the target local directory is missing from `project_list` and you are working locally in Antigravity, call `project_register` to validate, persist into `config/hub.json`, and hot-reload it immediately without restarting the Hub (local-only; never exposed on remote MCP).
2. **Choose Task Mode**
   - `precheck`: Read-only feasibility and risk audit before making risky changes.
   - `readonly_research`: Fast repository scanning and structured extraction without modifying files.
   - `execute`: Scoped implementation, test writing, or bugfix (requires `permissionMode === "codex_work"`).
3. **Submit Asynchronously & Wait with Zero LLM Tokens**
   - Call `codex_submit` with a concise, self-contained prompt and optional `idempotencyKey`. For independent `readonly_research` or `precheck` tasks, submit the entire batch in one turn (note: `execute` tasks on the same `projectId` are serialized by the Hub's project write lock).
   - **Zero-Token Background Wait (REQUIRED in Antigravity)**: immediately after submitting, launch **one** background `run_command` (`WaitMsBeforeAsync: 5000`, `NotificationTimeoutSeconds: 615`) and **stop calling tools** to yield the turn at zero LLM token cost:
     ```powershell
     node "$env:USERPROFILE\.gemini\config\plugins\ai-collab-hub\skills\codex-collab\scripts\hub-wait-done.mjs" <taskId1> [taskId2...] --mode=all --timeout=600
     ```
     Use `--mode=any` if you want to wake as soon as any task in a parallel batch finishes.
   - **FORBIDDEN**: Do **not** loop MCP `codex_wait` calls or pair `codex_wait` with `schedule` timers inside Antigravity—every wake-up re-processes the entire conversation context. Only use a single non-looping `codex_wait` (`timeoutMs` default `12000`, max `15000`, `afterSeq: lastSeq`) as an emergency fallback if terminal access to `127.0.0.1:3789` is unavailable.
   - Inspect `contextUsage.pressure` in the wait/result summary (`high` or `critical` -> prefer starting a fresh `codex_submit` task over `codex_followup`).
4. **Handle Pauses, Results & Hygiene**
   - If `status === "WAITING_APPROVAL"`, notify the user with the pending command/reason and `monitorUrl` (`http://127.0.0.1:3789/ui`) so they can decide in the Desktop Web Console, then resume waiting via `hub-wait-done.mjs` once approved.
   - When `COMPLETED` or `FAILED`, call `codex_result` only if you need the full diff or un-truncated `finalMessage` beyond what `hub-wait-done.mjs` already summarized (note: hard timeouts preserve partial buffered diagnostics in `finalMessage`).
   - Always audit `risks_or_disagreements` and verify critical changes locally before reporting success.
   - Use `codex_followup` to continue on the same `threadId` (only when `contextUsage.pressure` is healthy) or `codex_interrupt` to abort a stuck turn.
   - **Tool Hygiene**: Do not repeat blocked path/permission reads on sibling files, and avoid nested PowerShell quote escaping on Git/JSON commands (use simple flags or `--args-file` / stdin heredocs).

## Rigorous Codex Prompt Authoring

When writing prompts for `codex_submit` or `codex_followup`, counter both insufficient autonomy and excessive defensiveness:

1. **Clear Scope & Definition of Done**: State the concrete goal, confirmed entry files/symbols, exact allowed file scope, and required verification commands/pass criteria.
2. **Authorize End-to-End Execution**: Explicitly instruct Codex to trace full call chains, read required context directly, and self-debug failing builds/tests until passing instead of stopping early to ask trivial questions.
3. **Prevent Excessive Defensiveness**: Explicitly state the task/file scope is owner-authorized; forbid refusing borderline tasks over hypothetical risks; forbid redundant try/catch, speculative null/type guards, unrelated refactors, or premature abstractions; and require concrete `path:line` or command-output evidence for research findings and `plan_concern`/`blocked` verdicts.
