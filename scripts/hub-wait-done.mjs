import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STOP_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_APPROVAL']);

function tryLoadLocalConfig() {
  const candidates = [
    join(resolve(__dirname, '..'), 'config', 'hub.json'),
    join(process.cwd(), 'config', 'hub.json'),
  ];
  for (const filePath of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Best-effort config lookup; fall back to defaults cleanly
    }
  }
  return null;
}

function parseCliArgs(argv) {
  const taskIds = [];
  let mode = 'all';
  let maxSeconds = null;
  let explicitUrl = null;

  for (const arg of argv) {
    if (arg.startsWith('--mode=')) {
      const val = arg.slice('--mode='.length).trim().toLowerCase();
      if (val !== 'all' && val !== 'any') {
        throw new Error(`Invalid --mode="${val}"; expected all or any`);
      }
      mode = val;
    } else if (arg.startsWith('--timeout=')) {
      const val = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error(`Invalid --timeout="${arg}"`);
      }
      maxSeconds = val;
    } else if (arg.startsWith('--url=')) {
      explicitUrl = arg.slice('--url='.length).trim().replace(/\/+$/, '');
    } else if (/^\d+(?:\.\d+)?$/.test(arg) && taskIds.length >= 1 && maxSeconds === null) {
      maxSeconds = Number(arg);
    } else if (!arg.startsWith('--')) {
      taskIds.push(arg);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (taskIds.length === 0) {
    throw new Error(
      'Usage: node hub-wait-done.mjs <taskId1> [taskId2...] [--mode=all|any] [--timeout=600] [--url=http://127.0.0.1:3789]'
    );
  }

  return {
    taskIds: [...new Set(taskIds)],
    mode,
    maxSeconds: maxSeconds ?? 600,
    explicitUrl,
  };
}

function summarizeContextUsage(tokenUsageJson) {
  if (!tokenUsageJson) return null;
  try {
    const parsed = JSON.parse(tokenUsageJson);
    const lastTurnTokens =
      typeof parsed?.last?.totalTokens === 'number' ? parsed.last.totalTokens : null;
    const modelContextWindow =
      typeof parsed?.modelContextWindow === 'number' ? parsed.modelContextWindow : null;
    if (lastTurnTokens === null || !modelContextWindow || modelContextWindow <= 0) {
      return null;
    }
    const utilizationPercent = Math.min(
      100,
      Math.round((lastTurnTokens / modelContextWindow) * 1000) / 10
    );
    const pressure =
      utilizationPercent >= 80
        ? 'critical'
        : utilizationPercent >= 65
          ? 'high'
          : utilizationPercent >= 40
            ? 'medium'
            : 'low';
    return {
      lastTurnTokens,
      modelContextWindow,
      utilizationPercent,
      pressure,
    };
  } catch {
    return null;
  }
}

function formatCompactTaskSummary(detail, baseUrl) {
  const task = detail.task;
  const approvals = Array.isArray(detail.approvals) ? detail.approvals : [];
  const pendingApprovals = approvals
    .filter((a) => a.status === 'PENDING')
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      summary: a.summary,
      command: a.command ?? null,
      cwd: a.cwd ?? null,
      reason: a.reason ?? null,
    }));

  const report = task.structuredReport ?? null;
  const rawFinal = typeof task.finalMessage === 'string' ? task.finalMessage.trim() : '';
  const finalMessagePreview =
    !report && rawFinal
      ? rawFinal.length > 600
        ? `${rawFinal.slice(0, 597)}...`
        : rawFinal
      : undefined;

  return {
    taskId: task.id,
    status: task.status,
    projectId: task.projectId,
    mode: task.mode,
    threadId: task.threadId ?? null,
    resumeCommand: detail.resumeCommand ?? (task.threadId ? `codex resume ${task.threadId}` : null),
    turnCount: task.turnCount,
    verdict: report?.verdict ?? null,
    summary: report?.summary ?? null,
    changed_files: Array.isArray(report?.changed_files) ? report.changed_files : [],
    risks_or_disagreements: Array.isArray(report?.risks_or_disagreements)
      ? report.risks_or_disagreements
      : [],
    verification_output: report?.verification_output ?? null,
    pendingApprovals,
    lastError: task.lastError ?? null,
    ...(finalMessagePreview ? { finalMessagePreview } : {}),
    contextUsage: summarizeContextUsage(task.tokenUsageJson),
    monitorUrl: `${baseUrl}/ui`,
  };
}

function isStoppingConditionMet(detailsMap, taskIds, mode) {
  const stopped = taskIds.filter((id) => STOP_STATUSES.has(detailsMap.get(id)?.task?.status));
  if (mode === 'any') return stopped.length > 0;
  return stopped.length === taskIds.length;
}

async function fetchTaskDetail(baseUrl, headers, taskId, signal) {
  const res = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
    headers,
    signal,
  });
  if (!res.ok) {
    throw new Error(`GET /api/tasks/${taskId} failed with HTTP ${res.status}`);
  }
  return res.json();
}

function sleep(ms, signal) {
  return new Promise((resolveSleep) => {
    if (signal.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolveSleep();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function watchTaskViaSse(baseUrl, headers, taskId, onSnapshot, isDone, signal) {
  while (!signal.aborted && !isDone()) {
    try {
      const streamUrl = `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/stream?afterSeq=999999999`;
      const res = await fetch(streamUrl, {
        headers: { ...headers, Accept: 'text/event-stream' },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!signal.aborted && !isDone()) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

        let sepIndex;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawBlock = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          if (!rawBlock.trim()) continue;

          let eventName = 'message';
          const dataLines = [];
          for (const line of rawBlock.split('\n')) {
            if (line.startsWith(':')) continue;
            if (line.startsWith('event:')) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              dataLines.push(line.slice(5).trimStart());
            }
          }

          if (eventName === 'task_snapshot' && dataLines.length > 0) {
            try {
              const snapshot = JSON.parse(dataLines.join('\n'));
              if (snapshot && snapshot.task) {
                onSnapshot(snapshot);
              }
            } catch {
              // Ignore malformed SSE JSON payload
            }
          }
        }
      }
      await reader.cancel().catch(() => undefined);
    } catch {
      if (signal.aborted || isDone()) break;
    }

    if (signal.aborted || isDone()) break;
    await sleep(1000, signal);
    if (signal.aborted || isDone()) break;
    try {
      const detail = await fetchTaskDetail(baseUrl, headers, taskId, signal);
      if (detail && detail.task) {
        onSnapshot(detail);
      }
    } catch {
      // Retry SSE loop until deadline
    }
  }
}

async function main() {
  const { taskIds, mode, maxSeconds, explicitUrl } = parseCliArgs(process.argv.slice(2));
  const localConfig = tryLoadLocalConfig();
  const host = localConfig?.host || '127.0.0.1';
  const port = localConfig?.port || 3789;
  const baseUrl =
    explicitUrl ||
    process.env.HUB_BASE_URL?.trim().replace(/\/+$/, '') ||
    `http://${host}:${port}`;

  const token = process.env.HUB_LOCAL_TOKEN?.trim() || localConfig?.localToken || '';
  const headers = token ? { 'X-Hub-Token': token } : {};

  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), Math.max(100, maxSeconds * 1000));

  const detailsMap = new Map();
  try {
    const initial = await Promise.all(
      taskIds.map((id) => fetchTaskDetail(baseUrl, headers, id, controller.signal))
    );
    for (let i = 0; i < taskIds.length; i++) {
      detailsMap.set(taskIds[i], initial[i]);
    }

    if (!isStoppingConditionMet(detailsMap, taskIds, mode)) {
      await new Promise((resolveWait) => {
        const checkDone = () => {
          if (isStoppingConditionMet(detailsMap, taskIds, mode) || controller.signal.aborted) {
            controller.abort();
            resolveWait();
          }
        };
        controller.signal.addEventListener('abort', checkDone, { once: true });

        for (const taskId of taskIds) {
          void watchTaskViaSse(
            baseUrl,
            headers,
            taskId,
            (snapshot) => {
              detailsMap.set(taskId, snapshot);
              checkDone();
            },
            () => isStoppingConditionMet(detailsMap, taskIds, mode),
            controller.signal
          );
        }
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
    controller.abort();
  }

  // Refresh final snapshot concisely in case any stream closed right at completion
  await Promise.all(
    taskIds.map(async (id) => {
      try {
        const fresh = await fetchTaskDetail(baseUrl, headers, id, AbortSignal.timeout(3000));
        if (fresh?.task) detailsMap.set(id, fresh);
      } catch {
        // Keep last observed snapshot
      }
    })
  );

  const timedOutWaiting = !isStoppingConditionMet(detailsMap, taskIds, mode);

  if (taskIds.length === 1) {
    const summary = formatCompactTaskSummary(detailsMap.get(taskIds[0]), baseUrl);
    if (timedOutWaiting) {
      console.log(JSON.stringify({ ...summary, timedOutWaiting: true }, null, 2));
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(summary, null, 2));
    if (summary.status === 'COMPLETED') process.exitCode = 0;
    else if (summary.status === 'WAITING_APPROVAL') process.exitCode = 2;
    else process.exitCode = 1;
    return;
  }

  const summaries = taskIds.map((id) => formatCompactTaskSummary(detailsMap.get(id), baseUrl));
  const stoppedSummaries = summaries.filter((s) => STOP_STATUSES.has(s.status));
  const completedCount = summaries.filter((s) => s.status === 'COMPLETED').length;

  console.log(
    JSON.stringify(
      {
        mode,
        timedOutWaiting,
        completedCount,
        totalCount: summaries.length,
        tasks: summaries,
        monitorUrl: `${baseUrl}/ui`,
      },
      null,
      2
    )
  );

  if (timedOutWaiting) {
    process.exitCode = 1;
  } else if (summaries.some((s) => s.status === 'WAITING_APPROVAL')) {
    process.exitCode = 2;
  } else if (mode === 'all') {
    process.exitCode = summaries.every((s) => s.status === 'COMPLETED') ? 0 : 1;
  } else {
    process.exitCode = stoppedSummaries.some((s) => s.status === 'COMPLETED') ? 0 : 1;
  }
}

main().catch((err) => {
  console.error('[hub-wait-done] FAILED:', err?.message || err);
  process.exitCode = 1;
});
