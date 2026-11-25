import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { TaskManager } from '../orchestrator/task-manager.js';
import type { ClientOrigin, IFileSandbox, IOAuthServer, ITaskStore } from '../types.js';
import { registerCodexTools } from './local-mcp-server.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function sandboxResult(run: () => Promise<unknown>) {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(await run(), null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
}

export function registerFileSandboxTools(
  server: McpServer,
  sandbox: IFileSandbox,
  store: ITaskStore,
  origin: ClientOrigin,
  allowRemoteDocsWrite: boolean
): void {
  function auditedInput<Shape extends z.ZodRawShape>(action: string, fields: Shape) {
    // The SDK validates inputs before calling a tool handler. Audit validation failures too.
    return z.object({ ...fields, projectId: z.string().min(1) }).refine((input) => {
      const projectId = input && typeof input === 'object' && 'projectId' in input ? input.projectId : null;
      try {
        store.appendAuditLog({
          origin, actor: origin, action,
          projectId: typeof projectId === 'string' && projectId !== '' ? projectId : null,
          detail: {},
        });
        return true;
      } catch {
        return false;
      }
    }, { when: () => true, message: 'File sandbox call could not be audited' });
  }

  const optionalLine = z.number().int().min(1).max(1_000_000).optional();
  const optionalDepth = z.number().int().min(0).max(20).optional();
  const optionalEntries = z.number().int().min(0).max(10_000).optional();
  const optionalBytes = z.number().int().min(0).max(1_048_576).optional();
  const optionalMatches = z.number().int().min(0).max(5_000).optional();

  server.registerTool('fs_list_dir', {
    title: 'List Project Directory',
    description: 'List files and directories in an authorized project.',
    inputSchema: auditedInput('fs_list_dir', {
      relativePath: z.string().optional().describe('Relative directory path within the project'),
      maxDepth: optionalDepth.describe('Maximum directory depth (0..20)'),
      maxEntries: optionalEntries.describe('Maximum entries to return (0..10000)'),
    }),
  }, ({ projectId, relativePath, maxDepth, maxEntries }) =>
    sandboxResult(() => sandbox.listDir(projectId, relativePath, { maxDepth, maxEntries })));

  server.registerTool('fs_read_lines', {
    title: 'Read File Lines',
    description: 'Read a range of lines from a text file in an authorized project.',
    inputSchema: auditedInput('fs_read_lines', {
      relativePath: z.string().min(1).describe('Relative file path within the project'),
      startLine: optionalLine.describe('1-based start line number'),
      endLine: optionalLine.describe('1-based end line number (inclusive)'),
      maxBytes: optionalBytes.describe('Maximum UTF-8 bytes to return'),
    }),
  }, ({ projectId, relativePath, startLine, endLine, maxBytes }) =>
    sandboxResult(() => sandbox.readLines(projectId, relativePath, startLine, endLine, { maxBytes })));

  server.registerTool('fs_search', {
    title: 'Search Project Files',
    description: 'Search authorized project files for literal text.',
    inputSchema: auditedInput('fs_search', {
      query: z.string().min(1).describe('Literal text to search for'),
      relativePath: z.string().optional().describe('Optional relative subdirectory or file filter'),
      maxMatches: optionalMatches.describe('Maximum matches to return (0..5000)'),
      caseSensitive: z.boolean().optional().describe('Whether search is case-sensitive'),
    }),
  }, ({ projectId, query, relativePath, maxMatches, caseSensitive }) =>
    sandboxResult(() => sandbox.searchFiles(projectId, query, { relativePath, maxMatches, caseSensitive })));

  server.registerTool('fs_git_diff', {
    title: 'Get Project Git Status and Diff',
    description: 'Get Git status and diff for an authorized project.',
    inputSchema: auditedInput('fs_git_diff', {
      maxDiffBytes: optionalBytes.describe('Maximum diff UTF-8 bytes to return'),
      includeUntracked: z.boolean().optional().describe('Whether to include untracked files'),
    }),
  }, ({ projectId, maxDiffBytes, includeUntracked }) =>
    sandboxResult(() => sandbox.gitStatusAndDiff(projectId, { maxDiffBytes, includeUntracked })));

  if (allowRemoteDocsWrite === true) {
    server.registerTool('fs_write_doc', {
      title: 'Write Project Doc',
      description: 'Write a document under the configured docs directory of a writable project.',
      inputSchema: auditedInput('fs_write_doc', {
        relativePath: z.string().min(1).describe('Relative target path inside project docs directory'),
        content: z.string().describe('UTF-8 document contents'),
        overwrite: z.boolean().optional().describe('Whether to overwrite an existing file'),
      }),
    }, ({ projectId, relativePath, content, overwrite }) =>
      sandboxResult(() => sandbox.writeDoc(projectId, relativePath, content, { overwrite })));
  }
}

function writeError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  // Keep the connection open long enough to send a 413 when a streamed body exceeds the limit.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export interface RemoteMcpHandlerOptions {
  oauthServer: IOAuthServer;
  taskManager: TaskManager;
  sandbox: IFileSandbox;
  store: ITaskStore;
  allowRemoteDocsWrite: boolean;
  getMonitorUrl: () => string;
}

export function createRemoteMcpHandler(options: RemoteMcpHandlerOptions) {
  return async function handleRemoteMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!options.oauthServer.verifyAccessToken(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', options.oauthServer.buildWwwAuthenticateHeader());
      writeError(res, 401, -32000, 'Unauthorized: invalid or missing Bearer token');
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      writeError(res, 405, -32000, 'Method not allowed on stateless MCP endpoint. Use POST.');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        req.resume();
        writeError(res, 413, -32000, 'Request body exceeds 2 MB');
      } else {
        writeError(res, 400, -32700, 'Invalid JSON request body');
      }
      return;
    }

    if (res.destroyed) return;
    const rpcMethod =
      body && typeof body === 'object' && 'method' in body && typeof (body as { method?: unknown }).method === 'string'
        ? (body as { method: string }).method
        : 'unknown';
    const calledTool =
      rpcMethod === 'tools/call' &&
      body &&
      typeof body === 'object' &&
      'params' in body &&
      (body as { params?: { name?: unknown } }).params &&
      typeof (body as { params?: { name?: unknown } }).params?.name === 'string'
        ? (body as { params: { name: string } }).params.name
        : null;
    console.log(`[remote-mcp] rpc=${rpcMethod}${calledTool ? ` tool=${calledTool}` : ''}`);

    const mcpServer = new McpServer({ name: 'ai-collab-hub', version: '0.1.0' });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.once('close', () => {
      // Closing the MCP server also closes its connected transport.
      void mcpServer.close().catch(() => undefined);
    });
    try {
      registerCodexTools(mcpServer, options.taskManager, options.sandbox, 'gemini_app', options.getMonitorUrl());
      registerFileSandboxTools(mcpServer, options.sandbox, options.store, 'gemini_app', options.allowRemoteDocsWrite);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      writeError(res, 500, -32603, 'Internal MCP error');
    }
  };
}
