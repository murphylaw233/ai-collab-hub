---
name: collab-orchestrator
description: Use when starting substantial engineering work, multi-step debugging, or planning/delegating across Antigravity, Gemini App (ai-collab-hub-assistant), and local Codex to decide the lowest-quota execution track.
---

# Cross-Agent Collaboration Orchestrator (`ai-collab-hub`)

Use this skill whenever a new project task or substantial feature/bugfix starts in Antigravity so work is routed cleanly across **Antigravity**, **Gemini App**, and **local Codex** without wasting Antigravity's 5-hour quota.

## Stage 1 — Initial Exploration & Direction Alignment (Antigravity)

1. Explore just enough to understand the repository layout, entry points, constraints, and existing behavior (use `find_by_name` / `rg` / targeted `read_file`, or `project_list` if working through the Hub).
2. Align with the user on the problem diagnosis, technical direction, constraints, and acceptance criteria.
3. Keep exploration concise so the Antigravity context stays lean before choosing an execution track.

## Stage 2 — Choose the Execution Track (Antigravity Decides & Recommends)

Explicitly classify the task and recommend the best track to the user:

### Track A — Hand Off to Gemini App → Codex (`ai-collab-hub-assistant`) [Default for Iterative / Heavy Execution]
Choose Track A when the work involves **multi-round implementation, algorithm/solver tuning, benchmarking, repeated test-fix loops, or large exploratory scans** where Antigravity does not need to stay in the minute-by-minute execution loop:
1. Verify the target project is registered in `project_list` with the needed `permissionMode` (`codex_work` for edits/tests). If it is not registered yet, call local-only `project_register` first so Gemini App can access it right away without restarting the Hub.
2. Write a self-contained handoff brief (prefer `<project>/docs/handoff-<slug>.md` if the project allows writes, or output the brief directly in chat for read-only targets) using the template below.
3. Give the user a ready-to-paste 2-to-3-line prompt to send in **Gemini App** (`@<custom-app-name>`) pointing to that brief so Gemini App + local Codex drive the multi-turn implementation without spending Antigravity quota.

### Track B — Direct Antigravity → Codex (Zero-Token Background Wait)
Choose Track B when Antigravity should directly manage Codex execution AND the task is **coarse-grained** (1 submission replaces 20+ Antigravity tool calls) or involves **parallel independent read-only scans** (`readonly_research` / `precheck`):
1. Follow the `codex-collab` skill strictly.
2. Submit one task or a parallel batch of read-only tasks via `codex_submit`.
3. **WAIT ONLY WITH ZERO-TOKEN SSE**: launch a single background `run_command` calling `hub-wait-done.mjs` (`--mode=all` or `--mode=any`) and stop calling tools immediately to yield the turn. Never poll `codex_wait` in a loop or use `schedule` timers.

### Track C — Direct Antigravity Execution
Choose Track C for **small 1–2 file edits**, **architecture/design/code-review documents**, or **quick local verifications** where the handoff overhead is larger than doing the edit directly.

## Stage 3 — Final Review & Context Hygiene

- When work returns from **Gemini App → Codex**, Antigravity runs focused review (`git status` / `git diff` / reading changed files and running verification checks) rather than repeating broad exploration.
- After completing a major milestone (or once a session grows long), recommend `/compact` or opening a fresh Antigravity conversation before starting the next milestone to prevent `O(N²)` prompt-size growth.

---

## Handoff Brief Template (Track A: Antigravity → Gemini App → Codex)

```markdown
# Handoff: <Task Title>

- **Project ID**: `<projectId from project_list>`
- **Goal & Definition of Done**: <Concrete expected behavior and exact passing commands>
- **Confirmed Entry Files & Symbols**:
  - `<path/to/file>`: <role / key symbol>
- **Technical Direction & Constraints**:
  - <Agreed design choices, invariants, forbidden edits>
- **Execution Plan for Gemini App (`ai-collab-hub-assistant`)**:
  1. Run `precheck` (or `readonly_research`) first if assumptions need verification before editing.
  2. Run `execute` with clear owner authorization, end-to-end debugging authority, strict file scope, and no redundant defensive boilerplate.
  3. Poll via `codex_wait` with `timeoutMs: 12000` (max `15000`) and `afterSeq: lastSeq`; check `contextUsage.pressure` before `codex_followup`.
  4. If `WAITING_APPROVAL`, ask the user to approve at `http://127.0.0.1:3789/ui`.
- **Verification & Report Back**:
  - Run `<test/build command>` and report changed files, `resumeCommand`, and exact test outcomes.
```
