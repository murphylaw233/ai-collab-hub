import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApprovalDecision, IFileSandbox, IOAuthServer, TaskStatus } from '../types.js';
import type { TaskManager } from '../orchestrator/task-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveUiHtmlPath(): string {
  const candidates = [
    resolve(__dirname, 'index.html'),
    resolve(__dirname, '../../src/ui/index.html'),
    resolve(__dirname, '../../../src/ui/index.html'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Unable to locate src/ui/index.html (checked: ${candidates.join(', ')})`);
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function isAllowedLocalHostHeader(hostHeader: string | undefined, boundHost: string): boolean {
  if (!hostHeader) return false;
  const hostname = hostHeader.replace(/:\d+$/, '').toLowerCase();
  if (boundHost === '127.0.0.1' || boundHost === 'localhost' || boundHost === '::1') {
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  }
  return true;
}

function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        rejectBody(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolveBody({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          rejectBody(new Error('Request body must be a JSON object'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch {
        rejectBody(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      rejectBody(err);
    });
  });
}

function parseIntParam(raw: string | null, defaultValue: number, min: number, max: number): number {
  if (!raw) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n)) return defaultValue;
  return Math.max(min, Math.min(max, n));
}

const VALID_STATUSES = new Set<TaskStatus>([
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

const VALID_DECISIONS = new Set<ApprovalDecision>([
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
]);

export interface UiApiRoutesOptions {
  boundHost: string;
  localToken: string;
  requireUiToken: boolean;
  taskManager: TaskManager;
  sandbox: IFileSandbox;
  oauthServer?: IOAuthServer;
  remoteInfo?: {
    enabled: boolean;
    publicBaseUrl: string | null;
  };
}

export function createUiApiHandler(options: UiApiRoutesOptions) {
  const uiHtmlPath = resolveUiHtmlPath();

  return async function handleUiOrApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<boolean> {
    if (!isAllowedLocalHostHeader(req.headers.host, options.boundHost)) {
      writeJson(res, 403, { error: 'Forbidden Host header' });
      return true;
    }

    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/') {
      res.writeHead(302, { Location: '/ui' });
      res.end();
      return true;
    }

    if (method === 'GET' && pathname === '/ui') {
      const html = readFileSync(uiHtmlPath, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return true;
    }

    if (!pathname.startsWith('/api/')) {
      return false;
    }

    if (options.requireUiToken) {
      const headerToken = req.headers['x-hub-token'];
      const tokenStr = Array.isArray(headerToken) ? headerToken[0] : headerToken;
      if (!tokenStr || !constantTimeEquals(tokenStr, options.localToken)) {
        writeJson(res, 401, { error: 'Unauthorized: invalid X-Hub-Token' });
        return true;
      }
    }

    if (method === 'POST') {
      const xrw = req.headers['x-requested-with'];
      const xrwValue = Array.isArray(xrw) ? xrw[0] : xrw;
      if (xrwValue !== 'ai-collab-hub-ui') {
        writeJson(res, 403, { error: 'Forbidden: missing X-Requested-With: ai-collab-hub-ui' });
        return true;
      }
    }

    if (method === 'GET' && pathname === '/api/health') {
      const health = options.taskManager.getHealthSummary();
      writeJson(res, 200, {
        ...health,
        remoteEnabled: Boolean(options.remoteInfo?.enabled),
        remotePublicUrl: options.remoteInfo?.publicBaseUrl ?? null,
        activeOAuthTokensCount: options.oauthServer ? options.oauthServer.countActiveTokens() : 0,
      });
      return true;
    }

    if (method === 'GET' && pathname === '/api/projects') {
      writeJson(res, 200, { projects: options.sandbox.listProjects() });
      return true;
    }

    if (method === 'GET' && pathname === '/api/tasks') {
      const statusParam = url.searchParams.get('status');
      const status = statusParam && VALID_STATUSES.has(statusParam as TaskStatus)
        ? (statusParam as TaskStatus)
        : undefined;
      if (statusParam && !status) {
        writeJson(res, 400, { error: `Invalid status filter: ${statusParam}` });
        return true;
      }
      const projectId = url.searchParams.get('projectId') || undefined;
      const limit = parseIntParam(url.searchParams.get('limit'), 50, 1, 200);
      const offset = parseIntParam(url.searchParams.get('offset'), 0, 0, 100_000);
      const tasks = options.taskManager.listTasks({ status, projectId, limit, offset });
      writeJson(res, 200, { tasks });
      return true;
    }

    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]);
      const detail = options.taskManager.getTaskDetail(taskId);
      if (!detail) {
        writeJson(res, 404, { error: 'Task not found' });
        return true;
      }
      writeJson(res, 200, detail);
      return true;
    }

    const eventsMatch = /^\/api\/tasks\/([^/]+)\/events$/.exec(pathname);
    if (method === 'GET' && eventsMatch) {
      const taskId = decodeURIComponent(eventsMatch[1]);
      const afterSeq = parseIntParam(url.searchParams.get('afterSeq'), 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = parseIntParam(url.searchParams.get('limit'), 500, 1, 1000);
      try {
        const events = options.taskManager.getTaskEvents(taskId, afterSeq, limit);
        writeJson(res, 200, { events });
      } catch (err) {
        writeJson(res, 404, { error: err instanceof Error ? err.message : 'Task not found' });
      }
      return true;
    }

    const streamMatch = /^\/api\/tasks\/([^/]+)\/stream$/.exec(pathname);
    if (method === 'GET' && streamMatch) {
      const taskId = decodeURIComponent(streamMatch[1]);
      const detail = options.taskManager.getTaskDetail(taskId);
      if (!detail) {
        writeJson(res, 404, { error: 'Task not found' });
        return true;
      }
      const afterSeq = parseIntParam(url.searchParams.get('afterSeq'), 0, 0, Number.MAX_SAFE_INTEGER);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      const sendFrame = (event: string, data: unknown, id?: number) => {
        if (res.writableEnded || res.destroyed) return;
        if (id !== undefined) res.write(`id: ${id}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const history = options.taskManager.getTaskEvents(taskId, afterSeq, 500);
      let lastSentSeq = afterSeq;
      for (const ev of history) {
        sendFrame('task_event', ev, ev.seq);
        lastSentSeq = Math.max(lastSentSeq, ev.seq);
      }
      sendFrame('task_snapshot', detail);

      const unsub = options.taskManager.subscribeTask(taskId, (msg) => {
        if (msg.kind === 'task_event') {
          if (msg.data.seq <= lastSentSeq) return;
          lastSentSeq = msg.data.seq;
          sendFrame('task_event', msg.data, msg.data.seq);
        } else if (msg.kind === 'task_snapshot') {
          sendFrame('task_snapshot', msg.data);
        } else if (msg.kind === 'approval_update') {
          sendFrame('approval_update', msg.data);
        }
      });

      const heartbeat = setInterval(() => {
        sendFrame('heartbeat', { ts: Date.now() });
      }, 15_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        unsub();
      });
      return true;
    }

    const interruptMatch = /^\/api\/tasks\/([^/]+)\/interrupt$/.exec(pathname);
    if (method === 'POST' && interruptMatch) {
      const taskId = decodeURIComponent(interruptMatch[1]);
      try {
        await readJsonBody(req);
        const task = await options.taskManager.interruptTask(taskId, 'desktop-ui', 'system');
        writeJson(res, 200, { ok: true, task });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg.includes('not found') ? 404 : 409;
        writeJson(res, code, { error: msg });
      }
      return true;
    }

    const decideMatch = /^\/api\/approvals\/([^/]+)\/decide$/.exec(pathname);
    if (method === 'POST' && decideMatch) {
      const approvalId = decodeURIComponent(decideMatch[1]);
      try {
        const body = await readJsonBody(req);
        const decision = body.decision;
        if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision as ApprovalDecision)) {
          writeJson(res, 400, { error: 'Invalid decision; expected accept | acceptForSession | decline | cancel' });
          return true;
        }
        const approval = options.taskManager.decideApproval(
          approvalId,
          decision as ApprovalDecision,
          'desktop-ui'
        );
        writeJson(res, 200, { ok: true, approval });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg.includes('not found') ? 404 : 409;
        writeJson(res, code, { error: msg });
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/oauth/revoke-all') {
      await readJsonBody(req);
      const revoked = options.oauthServer ? options.oauthServer.revokeAllTokens() : 0;
      writeJson(res, 200, { ok: true, revoked });
      return true;
    }

    writeJson(res, 404, { error: 'Not found' });
    return true;
  };
}
