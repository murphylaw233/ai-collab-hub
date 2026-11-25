import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHubConfig } from './config.js';
import { CodexAdapter } from './codex/codex-adapter.js';
import { createCodexRpcClient } from './codex/rpc-client.js';
import { createLocalMcpHandler } from './mcp/local-mcp-server.js';
import { createRemoteMcpHandler } from './mcp/remote-mcp-server.js';
import { createOAuthServer } from './oauth/oauth-server.js';
import { createSqliteOAuthStore } from './oauth/oauth-store.js';
import { TaskManager } from './orchestrator/task-manager.js';
import { createFileSandbox } from './sandbox/file-sandbox.js';
import { createSqliteTaskStore } from './store/sqlite-store.js';
import type {
  HubConfig,
  ICodexRpcClient,
  IFileSandbox,
  IOAuthServer,
  IOAuthStore,
  ITaskStore,
} from './types.js';
import { createUiApiHandler } from './ui/api-routes.js';

export interface CreateHubServerOptions {
  config?: HubConfig;
  store?: ITaskStore;
  sandbox?: IFileSandbox;
  rpcClient?: ICodexRpcClient;
  oauthStore?: IOAuthStore;
  oauthServer?: IOAuthServer;
  requireUiToken?: boolean;
}

export interface HubServerHandle {
  server: Server;
  remoteServer: Server | null;
  oauthServer: IOAuthServer | null;
  config: HubConfig;
  url: string;
  monitorUrl: string;
  mcpLocalUrl: string;
  remoteUrl: string | null;
  remoteMcpUrl: string | null;
  taskManager: TaskManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createHubServer(options: CreateHubServerOptions = {}): HubServerHandle {
  const config = options.config ?? loadHubConfig();
  const store = options.store ?? createSqliteTaskStore(config.dbPath);
  const sandbox = options.sandbox ?? createFileSandbox(config.projects);
  const rpcClient =
    options.rpcClient ??
    createCodexRpcClient({
      binPath: config.codex.binPath,
      transport: config.codex.transport,
      wsPort: config.codex.wsPort,
    });
  const adapter = new CodexAdapter(rpcClient, config.codex);
  const taskManager = new TaskManager(store, sandbox, adapter, config);

  const requireUiToken = options.requireUiToken ?? process.env.HUB_UI_REQUIRE_TOKEN === 'true';

  let boundPort = config.port;
  const formatHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  const baseUrl = () => `http://${formatHost}:${boundPort}`;

  const oauthServer: IOAuthServer | null = options.oauthServer
    ? options.oauthServer
    : config.remote.enabled
      ? createOAuthServer({
          store: options.oauthStore ?? createSqliteOAuthStore(config.dbPath),
          config: config.remote,
        })
      : null;

  const handleLocalMcp = createLocalMcpHandler({
    localToken: config.localToken,
    taskManager,
    sandbox,
    store,
    configPath: config.configPath,
    getMonitorUrl: () => `${baseUrl()}/ui`,
  });

  const handleUiOrApi = createUiApiHandler({
    boundHost: config.host,
    localToken: config.localToken,
    requireUiToken,
    taskManager,
    sandbox,
    oauthServer: oauthServer ?? undefined,
    remoteInfo: {
      enabled: config.remote.enabled,
      publicBaseUrl: config.remote.publicBaseUrl ?? null,
    },
  });

  const server = createServer(async (req, res) => {
    try {
      const hostHeader = req.headers.host || `${formatHost}:${boundPort}`;
      const reqUrl = new URL(req.url || '/', `http://${hostHeader}`);

      if (reqUrl.pathname === '/mcp/local') {
        await handleLocalMcp(req, res);
        return;
      }

      const handled = await handleUiOrApi(req, res, reqUrl);
      if (handled) return;

      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : 'Internal server error',
          })
        );
      }
    }
  });

  let boundRemotePort = config.remote.port;
  const remoteFormatHost = config.remote.host.includes(':')
    ? `[${config.remote.host}]`
    : config.remote.host;
  const remoteBaseUrl = () => `http://${remoteFormatHost}:${boundRemotePort}`;

  let remoteServer: Server | null = null;
  if (config.remote.enabled && oauthServer) {
    const handleRemoteMcp = createRemoteMcpHandler({
      oauthServer,
      taskManager,
      sandbox,
      store,
      allowRemoteDocsWrite: config.remote.allowRemoteDocsWrite,
      getMonitorUrl: () => `${baseUrl()}/ui`,
    });

    remoteServer = createServer(async (req, res) => {
      try {
        const fallbackBase = config.remote.publicBaseUrl ?? remoteBaseUrl();
        const hostHeader = req.headers.host;
        const reqUrl = new URL(req.url || '/', hostHeader ? `http://${hostHeader}` : fallbackBase);
        res.once('finish', () => {
          console.log(`[remote-gw] ${req.method} ${reqUrl.pathname} -> ${res.statusCode}`);
        });

        if (reqUrl.pathname === '/mcp/remote') {
          await handleRemoteMcp(req, res);
          return;
        }

        const handled = await oauthServer.handleHttpRequest(req, res, reqUrl);
        if (handled) return;

        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : 'Internal server error',
            })
          );
        }
      }
    });
  }

  let started = false;
  let stopped = false;

  const handle: HubServerHandle = {
    server,
    remoteServer,
    oauthServer,
    config,
    get url() {
      return baseUrl();
    },
    get monitorUrl() {
      return `${baseUrl()}/ui`;
    },
    get mcpLocalUrl() {
      return `${baseUrl()}/mcp/local`;
    },
    get remoteUrl() {
      return remoteServer ? remoteBaseUrl() : null;
    },
    get remoteMcpUrl() {
      return remoteServer ? `${remoteBaseUrl()}/mcp/remote` : null;
    },
    taskManager,
    async start() {
      if (started) return;
      started = true;
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(config.port, config.host, () => {
          server.off('error', rejectListen);
          const addr = server.address();
          if (addr && typeof addr !== 'string') {
            boundPort = addr.port;
          }
          resolveListen();
        });
      });

      if (remoteServer) {
        await new Promise<void>((resolveListen, rejectListen) => {
          remoteServer.once('error', rejectListen);
          remoteServer.listen(config.remote.port, config.remote.host, () => {
            remoteServer.off('error', rejectListen);
            const addr = remoteServer.address();
            if (addr && typeof addr !== 'string') {
              boundRemotePort = addr.port;
            }
            resolveListen();
          });
        });
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections?.();
      });
      if (remoteServer) {
        await new Promise<void>((resolveClose) => {
          remoteServer.close(() => resolveClose());
          remoteServer.closeAllConnections?.();
        });
      }
      await taskManager.shutdown();
      oauthServer?.close();
    },
  };

  return handle;
}

function isDirectEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
}

async function runCli(): Promise<void> {
  const hub = createHubServer();
  await hub.start();

  console.log('[ai-collab-hub] Hub started');
  console.log(`  Monitor UI : ${hub.monitorUrl}`);
  console.log(`  Local MCP  : ${hub.mcpLocalUrl}`);
  if (hub.config.remote.enabled && hub.remoteUrl) {
    console.log(`  Remote GW  : ${hub.remoteUrl}`);
    console.log(`  Remote MCP : ${hub.remoteMcpUrl}`);
    console.log(`  Remote Pub : ${hub.config.remote.publicBaseUrl ?? '(unset)'}`);
  } else {
    console.log('  Remote GW  : disabled');
  }
  console.log(`  Transport  : ${hub.config.codex.transport}`);
  console.log(`  Projects   : ${hub.config.projects.length}`);
  if (hub.config.localTokenGenerated) {
    console.log('  Local Token: generated ephemeral token for this run (set HUB_LOCAL_TOKEN or config/hub.json for stable MCP auth)');
  } else {
    console.log('  Local Token: loaded from config/env');
  }

  let exiting = false;
  const shutdown = async (signal: string) => {
    if (exiting) return;
    exiting = true;
    console.log(`\n[ai-collab-hub] Received ${signal}, shutting down...`);
    await hub.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (isDirectEntrypoint()) {
  runCli().catch((err) => {
    console.error('[ai-collab-hub] Fatal startup error:', err);
    process.exitCode = 1;
  });
}
