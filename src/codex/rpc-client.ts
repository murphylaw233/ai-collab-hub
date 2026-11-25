import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type {
  CodexRpcClientOptions,
  CodexTransportInfo,
  ICodexRpcClient,
  IncomingServerRequest,
  InitializeResultSummary,
} from '../types.js';

const moduleRoot = fileURLToPath(new URL('../../', import.meta.url));
const projectRoot = basename(moduleRoot) === 'dist' ? resolve(moduleRoot, '..') : moduleRoot;
const CONNECT_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 750;

type RequestId = string | number;
type ExitInfo = { code: number | null; signal: string | null };
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

interface Session {
  abort: AbortController;
  pending: Map<RequestId, PendingRequest>;
  startup?: Promise<InitializeResultSummary>;
  shutdown?: Promise<void>;
  ready: boolean;
  child?: ChildProcessWithoutNullStreams;
  childClosed?: Promise<void>;
  usesCmd?: boolean;
  socket?: WebSocket;
  wsUrl?: string;
  wsToken?: string;
  removeTokenFile?: () => void;
}

export function resolveCodexExecutable(binPath?: string): string {
  const arm64 = process.arch === 'arm64';
  const modules = join(projectRoot, 'node_modules');
  const native = join(modules, '@openai', arm64 ? 'codex-win32-arm64' : 'codex-win32-x64',
    'vendor', arm64 ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  for (const candidate of [binPath, process.env.CODEX_BIN, native, join(modules, '.bin', 'codex.cmd')]) {
    if (!candidate) continue;
    const absolutePath = resolve(candidate);
    if (statSync(absolutePath, { throwIfNoEntry: false })?.isFile()) return absolutePath;
  }
  throw new Error('Could not find a Codex executable via binPath, CODEX_BIN, or project node_modules');
}

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) reject(error);
        else if (address && typeof address !== 'string') resolvePort(address.port);
        else reject(new Error('Could not select a local WebSocket port'));
      });
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function spawnServer(bin: string, args: string[], cwd?: string): ChildProcessWithoutNullStreams {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONUTF8: process.env.PYTHONUTF8 ?? '1',
    PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? 'utf-8',
  };
  const options = { cwd, env: baseEnv, windowsHide: true, stdio: 'pipe' as const };
  switch (extname(bin).toLowerCase()) {
    case '.js':
    case '.mjs':
      return spawn(process.execPath, [bin, ...args], options);
    case '.cmd':
    case '.bat': {
      const env: NodeJS.ProcessEnv = { ...baseEnv };
      // Expand arguments inside quotes with delayed expansion disabled.
      const command = [bin, ...args].map((arg, index) => {
        const name = `CODEX_RPC_ARG_${index}`;
        env[name] = arg;
        return `"%${name}%"`;
      }).join(' ');
      return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', `"${command}"`], {
        ...options, env, windowsVerbatimArguments: true,
      });
    }
    default:
      return spawn(bin, args, options);
  }
}

async function killServer(session: Session): Promise<void> {
  const { child } = session;
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (session.usesCmd) {
    // Killing cmd.exe alone can leave the app-server behind.
    await new Promise<void>(resolveKill => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.once('error', () => resolveKill());
      killer.once('exit', () => resolveKill());
    });
  }
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

export class CodexRpcClient implements ICodexRpcClient {
  private readonly transport: CodexTransportInfo['transport'];
  private session?: Session;
  private nextId = 1;
  private readonly stderr: string[] = [];
  private readonly notifications = new Set<(method: string, params: unknown) => void>();
  private readonly serverRequests = new Set<(request: IncomingServerRequest) => void>();
  private readonly exits = new Set<(info: ExitInfo) => void>();

  constructor(private readonly options: CodexRpcClientOptions) {
    this.transport = options.transport ?? 'ws';
  }

  start(): Promise<InitializeResultSummary> {
    if (this.session?.shutdown) {
      return Promise.reject(new Error('Codex app-server is stopping'));
    }
    if (this.session?.startup) return this.session.startup;

    const session: Session = { abort: new AbortController(), pending: new Map(), ready: false };
    this.session = session;
    this.stderr.length = 0;
    session.startup = this.initialize(session).catch(async value => {
      const error = asError(value);
      await this.shutdown(session, error);
      throw error;
    });
    return session.startup;
  }

  stop(): Promise<void> {
    const session = this.session;
    return session ? this.shutdown(session, new Error('Codex app-server stopped')) : Promise.resolve();
  }

  isRunning(): boolean {
    return this.session?.ready === true && !this.session.abort.signal.aborted;
  }

  getTransportInfo(): CodexTransportInfo {
    const session = this.session?.abort.signal.aborted ? undefined : this.session;
    return {
      transport: this.transport,
      wsUrl: session?.wsUrl ?? null,
      wsTokenEnvVar: null,
      wsToken: session?.wsToken ?? null,
    };
  }

  getRecentStderr(): readonly string[] {
    return this.stderr.slice();
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const session = this.session;
    if (!session?.ready) return Promise.reject(new Error('Codex app-server is not initialized'));
    return this.sendRequest<T>(session, method, params, timeoutMs);
  }

  notify(method: string, params?: unknown): void {
    const session = this.session;
    if (!session?.ready) throw new Error('Codex app-server is not initialized');
    this.send(session, { method, params });
  }

  respondToServerRequest(id: RequestId, result: unknown): void {
    this.send(this.session, { id, result: result === undefined ? null : result });
  }

  rejectServerRequest(id: RequestId, code: number, message: string): void {
    this.send(this.session, { id, error: { code, message } });
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notifications.add(handler);
    return () => { this.notifications.delete(handler); };
  }

  onServerRequest(handler: (request: IncomingServerRequest) => void): () => void {
    this.serverRequests.add(handler);
    return () => { this.serverRequests.delete(handler); };
  }

  onExit(handler: (info: ExitInfo) => void): () => void {
    this.exits.add(handler);
    return () => { this.exits.delete(handler); };
  }

  private async initialize(session: Session): Promise<InitializeResultSummary> {
    const bin = resolveCodexExecutable(this.options.binPath);
    const args = ['app-server', '--listen', 'stdio://'];
    if (this.transport === 'ws') {
      const { wsPort } = this.options;
      const port = wsPort === undefined || wsPort === 0 ? await reservePort() : wsPort;
      session.abort.signal.throwIfAborted();
      const host = this.options.wsHost ?? '127.0.0.1';
      const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      const endpoint = new URL(`ws://${hostPart}:${port}`);
      if (endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
        throw new Error('Invalid Codex WebSocket host');
      }
      if (!Number.isInteger(port) || port < 1 || Number(endpoint.port || 80) !== port) {
        throw new Error('Invalid Codex WebSocket port');
      }

      const token = randomBytes(32).toString('hex');
      const directory = mkdtempSync(join(tmpdir(), 'codex-ws-'));
      const tokenFile = join(directory, 'token');
      const remove = () => {
        try { unlinkSync(tokenFile); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        try { rmdirSync(directory); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
      const onParentExit = () => {
        try { remove(); } catch { /* The process is already exiting. */ }
      };
      process.once('exit', onParentExit);
      session.removeTokenFile = () => {
        remove();
        process.off('exit', onParentExit);
      };
      writeFileSync(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
      session.wsUrl = `ws://${endpoint.hostname}:${port}`;
      session.wsToken = token;
      args[2] = session.wsUrl;
      args.push('--ws-auth', 'capability-token', '--ws-token-file', tokenFile);
    }

    session.child = spawnServer(bin, args, this.options.cwd);
    session.usesCmd = /\.(cmd|bat)$/i.test(bin);
    this.watchChild(session, session.child);
    if (session.wsUrl && session.wsToken) await this.connectWebSocket(session, session.wsUrl, session.wsToken);

    const result = await this.sendRequest(session, 'initialize', {
      clientInfo: this.options.clientInfo ?? { name: 'ai-collab-hub', title: 'AI Collab Hub', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const raw = asRecord(result);
    if (!raw) throw new Error('Invalid Codex initialize result');
    this.send(session, { method: 'initialized' });
    session.ready = true;
    return {
      userAgent: typeof raw.userAgent === 'string' ? raw.userAgent : null,
      platformFamily: typeof raw.platformFamily === 'string' ? raw.platformFamily : null,
      platformOs: typeof raw.platformOs === 'string' ? raw.platformOs : null,
      raw,
    };
  }

  private watchChild(session: Session, child: ChildProcessWithoutNullStreams): void {
    session.childClosed = new Promise(resolveClosed => child.once('close', () => resolveClosed()));
    child.once('error', error => this.onDisconnect(session, error));
    child.stdin.on('error', error => this.onDisconnect(session, error));
    child.once('exit', (code, signal) => {
      this.onDisconnect(session, new Error(`Codex app-server exited (code=${code}, signal=${signal})`));
      this.dispatch(session, this.exits, { code, signal });
    });

    const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderr.on('line', line => this.recordDiagnostic(session, line));
    if (this.transport === 'stdio') {
      const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
      stdout.on('line', line => this.receive(session, line));
      stdout.on('close', () => this.onDisconnect(session, new Error('Codex app-server stdout closed')));
    } else {
      child.stdout.resume();
    }
  }

  private async connectWebSocket(session: Session, url: string, token: string): Promise<void> {
    const { signal } = session.abort;
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    let backoff = 50;
    let lastError: Error | undefined;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        handshakeTimeout: Math.max(1, deadline - Date.now()),
      });
      session.socket = socket;
      try {
        await new Promise<void>((connected, rejected) => {
          let opened = false;
          socket.once('open', () => { opened = true; connected(); });
          socket.on('message', data => {
            for (const line of data.toString().split(/\r?\n/)) this.receive(session, line);
          });
          socket.on('error', error => {
            if (opened) this.onDisconnect(session, error);
            else rejected(error);
          });
          socket.once('close', code => {
            const error = new Error(`Codex WebSocket closed (code=${code})`);
            if (opened) this.onDisconnect(session, error);
            else rejected(error);
          });
        });
        signal.throwIfAborted();
        return;
      } catch (error) {
        signal.throwIfAborted();
        lastError = asError(error);
      }
      await delay(Math.max(0, Math.min(backoff, deadline - Date.now())), undefined, { signal })
        .catch(error => { signal.throwIfAborted(); throw error; });
      backoff = Math.min(backoff * 2, 500);
    }
    throw new Error('Timed out connecting to the Codex WebSocket', { cause: lastError });
  }

  private sendRequest<T>(
    session: Session,
    method: string,
    params?: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 20_000,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolveRequest, reject) => {
      const take = () => this.takePending(session, id);
      const timer = setTimeout(() => {
        take()?.reject(new Error(`Codex RPC timeout after ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      session.pending.set(id, { resolve: value => resolveRequest(value as T), reject, timer });
      try {
        this.send(session, { id, method, params });
      } catch (error) {
        take()?.reject(asError(error));
      }
    });
  }

  private send(session: Session | undefined, message: object): void {
    if (!session) throw new Error('Codex app-server is not connected');
    session.abort.signal.throwIfAborted();
    const payload = JSON.stringify(message);
    const onWriteError = (error?: Error | null) => {
      if (error) this.onDisconnect(session, error);
    };
    if (this.transport === 'ws' && session.socket?.readyState === WebSocket.OPEN) {
      session.socket.send(payload, onWriteError);
    } else if (this.transport === 'stdio' && session.child?.stdin.writable) {
      session.child.stdin.write(payload + '\n', onWriteError);
    } else {
      throw new Error('Codex app-server is not connected');
    }
  }

  private receive(session: Session, line: string): void {
    if (session.abort.signal.aborted) return;
    let message: Record<string, unknown> | undefined;
    try { message = asRecord(JSON.parse(line)); }
    catch { return; }
    if (!message) return;
    const { id, method, params } = message;
    if (typeof id === 'string' || typeof id === 'number') {
      if (typeof method === 'string') {
        this.dispatch(session, this.serverRequests, { id, method, params });
        return;
      }
      const pending = this.takePending(session, id);
      if (!pending) return;
      const error = asRecord(message.error);
      if (error) {
        pending.reject(Object.assign(new Error(`Codex RPC error (${error.code}): ${error.message}`), {
          code: error.code, data: error.data,
        }));
      } else {
        pending.resolve(message.result);
      }
    } else if (id == null && typeof method === 'string') {
      this.dispatch(session, this.notifications, method, params);
    }
  }

  private takePending(session: Session, id: RequestId): PendingRequest | undefined {
    const pending = session.pending.get(id);
    if (pending) {
      session.pending.delete(id);
      clearTimeout(pending.timer);
    }
    return pending;
  }

  private dispatch<T extends unknown[]>(session: Session, handlers: Set<(...args: T) => void>, ...args: T): void {
    for (const handler of handlers) {
      try { handler(...args); }
      catch (error) { this.recordDiagnostic(session, `RPC listener failed: ${asError(error).message}`); }
    }
  }

  private recordDiagnostic(session: Session, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.stderr.push(session.wsToken ? trimmed.replaceAll(session.wsToken, '[redacted]') : trimmed);
    if (this.stderr.length > 40) this.stderr.shift();
  }

  private onDisconnect(session: Session, error: Error): void {
    if (!session.abort.signal.aborted) {
      void this.shutdown(session, error).catch(value => this.recordDiagnostic(session, asError(value).message));
    }
  }

  private shutdown(session: Session, error: Error): Promise<void> {
    if (session.shutdown) return session.shutdown;
    session.shutdown = Promise.resolve().then(() => this.dispose(session)).finally(() => {
      if (this.session === session) this.session = undefined;
    });
    session.abort.abort(error);
    for (const id of session.pending.keys()) this.takePending(session, id)?.reject(error);
    return session.shutdown;
  }

  private async dispose(session: Session): Promise<void> {
    const { socket, child, childClosed } = session;
    try {
      const socketClosed = new Promise<void>(resolveClosed => {
        if (!socket || socket.readyState === WebSocket.CLOSED) {
          resolveClosed();
          return;
        }
        socket.once('close', () => resolveClosed());
        if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
        else socket.close();
      });
      child?.stdin.end();
      const closed = Promise.all([socketClosed, childClosed]);
      const timer = new AbortController();
      try {
        await Promise.race([closed, delay(SHUTDOWN_GRACE_MS, undefined, { signal: timer.signal })]);
      } finally {
        timer.abort();
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      await killServer(session);
      child?.stdin.destroy();
      child?.stdout.destroy();
      child?.stderr.destroy();
      const postKillTimer = new AbortController();
      try {
        await Promise.race([
          closed,
          delay(1_500, undefined, { signal: postKillTimer.signal }),
        ]);
      } finally {
        postKillTimer.abort();
      }
    } finally {
      session.removeTokenFile?.();
    }
  }
}

export function createCodexRpcClient(options: CodexRpcClientOptions): CodexRpcClient {
  return new CodexRpcClient(options);
}
