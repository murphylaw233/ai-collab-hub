# Local Monitor & Approval Web UI — HTTP / SSE API Contract

This document defines the exact HTTP and Server-Sent Events (SSE) contract between `src/ui/api-routes.ts` (server) and `src/ui/index.html` (single-page client).

## Security & CSRF Rules
- Server binds to `127.0.0.1:<port>` by default.
- `GET /ui` serves `src/ui/index.html` with `Content-Type: text/html; charset=utf-8`.
- Mutating endpoints (`POST /api/tasks/:id/interrupt` and `POST /api/approvals/:id/decide`) require the header:
  - `X-Requested-With: ai-collab-hub-ui` (prevents cross-site form/fetch CSRF from arbitrary browser tabs).
  - If `localToken` enforcement is enabled for `/api/*`, the UI also accepts a user-supplied token stored in `localStorage` (`hub_local_token`) and sends it via `X-Hub-Token: <token>`.

---

## Endpoints

### 1. `GET /ui`
- Returns the single-file Web Monitor & L2 Approval UI (`src/ui/index.html`).

### 2. `GET /api/health`
- Response `200`:
```json
{
  "ok": true,
  "codexRunning": true,
  "transport": "ws",
  "wsUrl": "ws://127.0.0.1:4500",
  "pendingApprovalsCount": 1,
  "runningTasksCount": 1
}
```

### 3. `GET /api/projects`
- Response `200`:
```json
{
  "projects": [
    {
      "id": "demo-active-app",
      "name": "Demo Active App",
      "rootPath": "D:\\Projects\\example-app",
      "permissionMode": "codex_work",
      "docsSubdir": "docs",
      "description": "..."
    }
  ]
}
```

### 4. `GET /api/tasks`
- Query parameters (all optional):
  - `status`: `QUEUED | RUNNING | WAITING_APPROVAL | COMPLETED | FAILED | CANCELLED`
  - `projectId`: string
  - `limit`: integer (default `50`, max `200`)
  - `offset`: integer (default `0`)
- Response `200`:
```json
{
  "tasks": [ /* TaskRecord[] */ ]
}
```

### 5. `GET /api/tasks/:id`
- Response `200`:
```json
{
  "task": { /* TaskRecord */ },
  "approvals": [ /* ApprovalRecord[] */ ],
  "resumeCommand": "codex resume 019abc..."
}
```
- `resumeCommand` is `null` if `task.threadId` is `null`.
- Response `404`: `{ "error": "Task not found" }`.

### 6. `GET /api/tasks/:id/events?afterSeq=0&limit=500`
- Query parameters:
  - `afterSeq`: integer (default `0`; returns events with `seq > afterSeq` ordered ascending by `seq`)
  - `limit`: integer (default `500`, max `1000`)
- Response `200`:
```json
{
  "events": [ /* TaskEventRecord[] */ ]
}
```

### 7. `GET /api/tasks/:id/stream?afterSeq=0`
- Response `200` with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache`, `Connection: keep-alive`.
- On connect, replays any persisted events with `seq > afterSeq` (up to batch limit) and emits a `task_snapshot`, then streams live updates:
  - `event: task_snapshot` — `data: { "task": TaskRecord, "approvals": ApprovalRecord[], "resumeCommand": string | null }`
  - `event: task_event` — `data: TaskEventRecord` (uses `id: <seq>` SSE frame field so `EventSource` or custom reconnect can track `afterSeq`)
  - `event: approval_update` — `data: ApprovalRecord`
  - `event: heartbeat` — `data: { "ts": 1763950000000 }` (every ~15s)

### 8. `POST /api/tasks/:id/interrupt`
- Required header: `X-Requested-With: ai-collab-hub-ui`
- Body: `{}` (optional)
- Response `200`: `{ "ok": true, "task": /* TaskRecord */ }`
- Response `409`: `{ "error": "Task is not running" }`

### 9. `POST /api/approvals/:id/decide`
- Required header: `X-Requested-With: ai-collab-hub-ui`
- Body:
```json
{
  "decision": "accept"
}
```
  - Allowed `decision` values: `"accept" | "acceptForSession" | "decline" | "cancel"`
- Response `200`: `{ "ok": true, "approval": /* ApprovalRecord */ }`
- Response `400` / `404` / `409`: `{ "error": "..." }`
