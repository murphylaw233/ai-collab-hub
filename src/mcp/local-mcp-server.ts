import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ClientOrigin, IFileSandbox, ITaskStore, ProjectConfig, TaskStatus } from '../types.js';
import {
  ProjectConfigSchema,
  removeProjectFromConfigFile,
  upsertProjectInConfigFile,
  validateProjectRootForRegistration,
} from '../config.js';
import {
  compactEventsForWait,
  computeContextUsage,
  type TaskManager,
} from '../orchestrator/task-manager.js';

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function toolOk(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function toolErr(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  };
}

function readJsonBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

export function registerCodexTools(
  server: McpServer,
  taskManager: TaskManager,
  sandbox: IFileSandbox,
  origin: ClientOrigin,
  monitorUrl: string
): void {
  server.registerTool(
    'project_list',
    {
      title: 'List Authorized Projects',
      description: 'List all authorized local workspace projects and their permission modes.',
      inputSchema: {},
    },
    async () => {
      try {
        return toolOk({ projects: sandbox.listProjects() });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_submit',
    {
      title: 'Submit Codex Task',
      description:
        'Submit an asynchronous task to local Codex (precheck, readonly_research, or execute). Returns immediately with taskId.',
      inputSchema: {
        projectId: z.string().min(1).describe('Registered project ID from project_list'),
        mode: z
          .enum(['precheck', 'readonly_research', 'execute'])
          .describe('precheck/readonly_research run read-only; execute allows scoped workspace edits'),
        prompt: z.string().min(1).describe('Clear task instruction for Codex'),
        idempotencyKey: z.string().min(1).optional().describe('Optional deduplication key'),
        model: z.string().min(1).optional().describe('Optional Codex model override'),
      },
    },
    async ({ projectId, mode, prompt, idempotencyKey, model }) => {
      try {
        const result = taskManager.submitTask({
          origin,
          projectId,
          mode,
          prompt,
          idempotencyKey,
          model,
        });
        return toolOk({
          taskId: result.task.id,
          status: result.task.status,
          mode: result.task.mode,
          projectId: result.task.projectId,
          deduplicated: result.deduplicated,
          threadId: result.task.threadId,
          resumeCommand: result.resumeCommand,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_wait',
    {
      title: 'Wait for Codex Task',
      description:
        'Wait briefly (up to 15s) until the Codex task finishes, fails, cancels, or pauses for L2 human approval.',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID returned by codex_submit'),
        timeoutMs: z
          .number()
          .int()
          .min(500)
          .max(15_000)
          .optional()
          .describe('Wait timeout in ms (500..15000, default 12000; kept under 20s upstream gateway timeout)'),
        afterSeq: z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .optional()
          .describe('Incremental event cursor; only return events with seq > afterSeq'),
      },
    },
    async ({ taskId, timeoutMs, afterSeq }) => {
      try {
        const res = await taskManager.waitTask(taskId, timeoutMs ?? 12_000, afterSeq ?? 0);
        const pendingApprovals = res.approvals.filter((a) => a.status === 'PENDING');
        return toolOk({
          taskId: res.task.id,
          status: res.task.status,
          timedOut: res.timedOut,
          threadId: res.task.threadId,
          resumeCommand: res.resumeCommand,
          turnCount: res.task.turnCount,
          lastSeq: res.lastSeq,
          lastError: res.task.lastError,
          structuredReport: res.task.structuredReport,
          progress: res.progress,
          contextUsage: res.contextUsage,
          pendingApprovals: pendingApprovals.map((a) => ({
            id: a.id,
            kind: a.kind,
            summary: a.summary,
            command: a.command,
            cwd: a.cwd,
            reason: a.reason,
          })),
          actionHint:
            res.task.status === 'WAITING_APPROVAL'
              ? `Task is paused awaiting human approval at ${monitorUrl}`
              : null,
          recentEvents: res.compactedEvents,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_status',
    {
      title: 'Get Codex Task Status',
      description: 'Inspect current task status, threadId, approvals, and resume command.',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID'),
      },
    },
    async ({ taskId }) => {
      try {
        const detail = taskManager.getTaskDetail(taskId);
        if (!detail) return toolErr(new Error(`Task not found: ${taskId}`));
        return toolOk({
          task: detail.task,
          approvals: detail.approvals,
          progress: taskManager.getTaskProgress(detail.task),
          contextUsage: computeContextUsage(detail.task.tokenUsageJson),
          resumeCommand: detail.resumeCommand,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_result',
    {
      title: 'Get Codex Task Result',
      description:
        'Retrieve structured report, final message, latest diff, approvals, and optional event log for a task.',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID'),
        diffMaxBytes: z
          .number()
          .int()
          .min(1024)
          .max(200_000)
          .optional()
          .describe('Max UTF-8 bytes of latestDiff to return (default 32768)'),
        includeEvents: z.boolean().optional().describe('Whether to include recent events'),
      },
    },
    async ({ taskId, diffMaxBytes = 32_768, includeEvents = false }) => {
      try {
        const detail = taskManager.getTaskDetail(taskId);
        if (!detail) return toolErr(new Error(`Task not found: ${taskId}`));
        const rawDiff = detail.task.latestDiff ?? '';
        const diffBuf = Buffer.from(rawDiff, 'utf8');
        const diffTruncated = diffBuf.length > diffMaxBytes;
        const diff = diffTruncated
          ? diffBuf.subarray(0, diffMaxBytes).toString('utf8') + '\n...[diff truncated]...'
          : rawDiff;

        const events = includeEvents
          ? compactEventsForWait(taskManager.getTaskEvents(taskId, 0, 500), 30)
          : undefined;
        return toolOk({
          taskId: detail.task.id,
          projectId: detail.task.projectId,
          mode: detail.task.mode,
          status: detail.task.status,
          threadId: detail.task.threadId,
          resumeCommand: detail.resumeCommand,
          turnCount: detail.task.turnCount,
          lastError: detail.task.lastError,
          structuredReport: detail.task.structuredReport,
          progress: taskManager.getTaskProgress(detail.task),
          contextUsage: computeContextUsage(detail.task.tokenUsageJson),
          finalMessage: detail.task.finalMessage,
          latestDiff: diff || null,
          diffTruncated,
          approvals: detail.approvals,
          events,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_followup',
    {
      title: 'Send Follow-up to Codex Task',
      description: 'Continue an existing Codex thread with a follow-up instruction.',
      inputSchema: {
        taskId: z.string().min(1).describe('Existing task ID with threadId'),
        prompt: z.string().min(1).describe('Follow-up instruction'),
        mode: z.enum(['precheck', 'readonly_research', 'execute']).optional(),
        model: z.string().min(1).optional(),
      },
    },
    async ({ taskId, prompt, mode, model }) => {
      try {
        const task = taskManager.followupTask({
          origin,
          taskId,
          prompt,
          mode,
          model,
        });
        return toolOk({
          taskId: task.id,
          status: task.status,
          threadId: task.threadId,
          turnCount: task.turnCount,
          resumeCommand: task.threadId ? `codex resume ${task.threadId}` : null,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_interrupt',
    {
      title: 'Interrupt Codex Task',
      description: 'Interrupt and cancel a queued, running, or waiting task.',
      inputSchema: {
        taskId: z.string().min(1).describe('Task ID to cancel'),
      },
    },
    async ({ taskId }) => {
      try {
        const task = await taskManager.interruptTask(taskId, origin, origin);
        return toolOk({
          taskId: task.id,
          status: task.status,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'codex_list_tasks',
    {
      title: 'List Codex Tasks',
      description: 'List recent Codex tasks optionally filtered by status or projectId.',
      inputSchema: {
        status: z
          .enum(['QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'])
          .optional(),
        projectId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ status, projectId, limit }) => {
      try {
        const tasks = taskManager.listTasks({
          status: status as TaskStatus | undefined,
          projectId,
          limit: limit ?? 25,
        });
        return toolOk({
          tasks: tasks.map((t) => ({
            id: t.id,
            origin: t.origin,
            projectId: t.projectId,
            mode: t.mode,
            status: t.status,
            threadId: t.threadId,
            turnCount: t.turnCount,
            verdict: t.structuredReport?.verdict ?? null,
            updatedAt: t.updatedAt,
          })),
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );
}

export interface LocalMcpHandlerOptions {
  localToken: string;
  taskManager: TaskManager;
  sandbox: IFileSandbox;
  store?: ITaskStore;
  configPath?: string;
  getMonitorUrl: () => string;
}

export function registerLocalProjectAdminTools(
  server: McpServer,
  taskManager: TaskManager,
  sandbox: IFileSandbox,
  store: ITaskStore | undefined,
  configPath: string | undefined,
  monitorUrl: string
): void {
  server.registerTool(
    'project_register',
    {
      title: 'Register Authorized Project',
      description:
        'Register or update an authorized local workspace project (local Antigravity MCP only; persists to config and hot-reloads immediately).',
      inputSchema: {
        id: z
          .string()
          .trim()
          .min(1)
          .regex(/^[a-zA-Z0-9_-]+$/, 'Project id must match /^[a-zA-Z0-9_-]+$/')
          .describe('Unique project ID (letters, digits, _, -)'),
        name: z.string().trim().min(1).describe('Human-readable project name'),
        rootPath: z.string().trim().min(1).describe('Existing absolute local directory path'),
        permissionMode: z
          .enum(['read_only', 'docs_write', 'codex_work'])
          .optional()
          .describe('Access level for this project (default codex_work)'),
        docsSubdir: z.string().trim().min(1).optional().describe('Docs subdirectory (default docs)'),
        description: z.string().optional().describe('Optional short description'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Set true to update an existing project with the same id (default false)'),
      },
    },
    async ({ id, name, rootPath, permissionMode, docsSubdir, description, overwrite }) => {
      try {
        const allowOverwrite = Boolean(overwrite);
        const existing = sandbox.listProjects().some((p) => p.id === id);
        if (existing && !allowOverwrite) {
          throw new Error(`Project "${id}" already exists (set overwrite=true to update)`);
        }

        const safeRoot = validateProjectRootForRegistration(rootPath);
        const normalizedProject: ProjectConfig = ProjectConfigSchema.parse({
          id,
          name,
          rootPath: safeRoot,
          permissionMode: permissionMode ?? 'codex_work',
          docsSubdir: docsSubdir ?? 'docs',
          ...(description !== undefined ? { description } : {}),
        });

        let created = !existing;
        if (configPath) {
          const persisted = upsertProjectInConfigFile(configPath, normalizedProject, allowOverwrite);
          created = persisted.created;
        }

        const project = sandbox.upsertProject(normalizedProject);
        store?.appendAuditLog({
          origin: 'antigravity',
          actor: 'antigravity',
          action: 'project_registered',
          projectId: id,
          detail: {
            permissionMode: normalizedProject.permissionMode,
            overwrite: allowOverwrite,
            persisted: Boolean(configPath),
          },
        });

        return toolOk({
          ok: true,
          created,
          persisted: Boolean(configPath),
          project,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );

  server.registerTool(
    'project_remove',
    {
      title: 'Remove Authorized Project',
      description:
        'Unregister an authorized local workspace project (local Antigravity MCP only; blocks removal while tasks are active).',
      inputSchema: {
        projectId: z.string().trim().min(1).describe('Project ID to remove'),
      },
    },
    async ({ projectId }) => {
      try {
        for (const activeStatus of ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'] as const) {
          const active = taskManager.listTasks({ projectId, status: activeStatus, limit: 10 });
          if (active.length > 0) {
            throw new Error(
              `Cannot remove project "${projectId}" while task "${active[0].id}" is ${activeStatus}`
            );
          }
        }

        const removedFromConfig = configPath
          ? removeProjectFromConfigFile(configPath, projectId)
          : false;
        const removedFromSandbox = sandbox.removeProject(projectId);
        const removed = removedFromConfig || removedFromSandbox;

        store?.appendAuditLog({
          origin: 'antigravity',
          actor: 'antigravity',
          action: 'project_removed',
          projectId,
          detail: {
            removed,
            persisted: Boolean(configPath),
          },
        });

        return toolOk({
          ok: true,
          removed,
          persisted: Boolean(configPath),
          projectId,
          monitorUrl,
        });
      } catch (err) {
        return toolErr(err);
      }
    }
  );
}

export function createLocalMcpHandler(options: LocalMcpHandlerOptions) {
  return async function handleLocalMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization;
    const expected = `Bearer ${options.localToken}`;
    if (!authHeader || !constantTimeEquals(authHeader, expected)) {
      writeJson(res, 401, { error: 'Unauthorized: invalid or missing Bearer token' });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed on stateless MCP endpoint; use POST.' },
        id: null,
      });
      return;
    }

    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch (err) {
      writeJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: err instanceof Error ? err.message : 'Invalid JSON' },
        id: null,
      });
      return;
    }

    const mcpServer = new McpServer({
      name: 'ai-collab-hub',
      version: '0.1.0',
    });
    const monitorUrl = options.getMonitorUrl();
    registerCodexTools(mcpServer, options.taskManager, options.sandbox, 'antigravity', monitorUrl);
    registerLocalProjectAdminTools(
      mcpServer,
      options.taskManager,
      options.sandbox,
      options.store,
      options.configPath,
      monitorUrl
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.once('close', () => {
      void transport.close().catch(() => undefined);
      void mcpServer.close().catch(() => undefined);
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      if (!res.headersSent) {
        writeJson(res, 500, {
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : 'Internal MCP error',
          },
          id: null,
        });
      }
    }
  };
}
