import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const LIVE_TURN = process.argv.includes('--live-turn');
const TIMEOUT_MS = 60_000;

function resolveCodexBinary() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
    return { command: process.env.CODEX_BIN, argsPrefix: [], kind: 'env:CODEX_BIN' };
  }

  const archDir = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const pkgDir = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const nativeExe = join(PROJECT_ROOT, 'node_modules', '@openai', pkgDir, 'vendor', archDir, 'bin', 'codex.exe');
  if (existsSync(nativeExe)) {
    return { command: nativeExe, argsPrefix: [], kind: 'native-exe' };
  }

  const cmdShim = join(PROJECT_ROOT, 'node_modules', '.bin', 'codex.cmd');
  if (existsSync(cmdShim)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', cmdShim],
      kind: 'cmd-shim',
    };
  }

  throw new Error('Unable to locate codex binary in CODEX_BIN or node_modules/@openai.');
}

function sanitizeAccountResponse(res) {
  if (!res || typeof res !== 'object') return res;
  const acct = res.account;
  let safeAccount = null;
  if (acct && typeof acct === 'object') {
    safeAccount = {
      type: acct.type ?? null,
      planType: acct.planType ?? null,
      workspaceName: acct.workspaceName ?? null,
      hasEmail: Boolean(acct.email),
    };
  }
  return {
    authenticated: Boolean(safeAccount),
    requiresOpenaiAuth: Boolean(res.requiresOpenaiAuth),
    hasUserId: Boolean(res.userId),
    account: safeAccount,
    workspaceRouting: res.workspaceRouting ?? null,
  };
}

class AppServerClient {
  constructor(bin) {
    this.bin = bin;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationMethods = new Set();
    this.serverRequests = [];
    this.stderrLines = [];
    this.notificationHandlers = new Set();
    this.closed = false;
  }

  start() {
    const args = [...this.bin.argsPrefix, 'app-server', '--listen', 'stdio://'];
    this.child = spawn(this.bin.command, args, {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.rlOut = readline.createInterface({ input: this.child.stdout });
    this.rlOut.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        this.stderrLines.push(`[stdout-non-json] ${trimmed}`);
        return;
      }
      this.#handleMessage(msg);
    });

    this.rlErr = readline.createInterface({ input: this.child.stderr });
    this.rlErr.on('line', (line) => {
      if (line.trim()) this.stderrLines.push(line.trim());
    });

    this.exitPromise = new Promise((resolveExit) => {
      this.child.on('exit', (code, signal) => {
        this.closed = true;
        for (const [, p] of this.pending) {
          p.reject(new Error(`codex app-server exited unexpectedly (code=${code}, signal=${signal})`));
        }
        this.pending.clear();
        resolveExit({ code, signal });
      });
      this.child.on('error', (err) => {
        this.closed = true;
        for (const [, p] of this.pending) {
          p.reject(err);
        }
        this.pending.clear();
      });
    });
  }

  #handleMessage(msg) {
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
    const hasMethod = typeof msg.method === 'string';

    // Server -> Client Request (has both id and method)
    if (hasId && hasMethod) {
      this.serverRequests.push({ id: msg.id, method: msg.method });
      this.#sendRaw({
        id: msg.id,
        error: {
          code: -32000,
          message: `Phase 0 probe does not permit interactive server request: ${msg.method}`,
        },
      });
      return;
    }

    // Response to Client Request
    if (hasId && !hasMethod) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(`RPC error (${msg.error.code}): ${msg.error.message}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // Server -> Client Notification
    if (hasMethod) {
      this.notificationMethods.add(msg.method);
      for (const handler of this.notificationHandlers) {
        handler(msg.method, msg.params);
      }
    }
  }

  #sendRaw(payload) {
    if (this.closed || !this.child?.stdin?.writable) {
      throw new Error('Cannot write to closed codex app-server stdin');
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectReq(new Error(`RPC timeout after ${timeoutMs}ms for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveReq, reject: rejectReq, timer });
      const msg = params === undefined ? { id, method } : { id, method, params };
      this.#sendRaw(msg);
    });
  }

  notify(method, params) {
    const msg = params === undefined ? { method } : { method, params };
    this.#sendRaw(msg);
  }

  onNotification(fn) {
    this.notificationHandlers.add(fn);
    return () => this.notificationHandlers.delete(fn);
  }

  async close() {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    await Promise.race([
      this.exitPromise,
      new Promise((r) => setTimeout(r, 1500)),
    ]);
    if (!this.closed) {
      this.child.kill();
      await this.exitPromise;
    }
  }
}

async function main() {
  const bin = resolveCodexBinary();
  console.log(`[probe] Resolved binary (${bin.kind}): ${bin.command}`);
  const client = new AppServerClient(bin);
  client.start();

  try {
    // 1. Handshake
    const initResult = await client.request('initialize', {
      clientInfo: {
        name: 'ai-collab-hub-probe',
        title: 'AI Collab Hub Phase 0 Probe',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    console.log('[probe] initialize OK:', JSON.stringify({
      userAgent: initResult?.userAgent ?? null,
      platformFamily: initResult?.platformFamily ?? null,
      platformOs: initResult?.platformOs ?? null,
    }));

    client.notify('initialized');

    // 2. Account check
    const rawAccount = await client.request('account/read', { refreshToken: false });
    const safeAccount = sanitizeAccountResponse(rawAccount);
    console.log('[probe] account/read:', JSON.stringify(safeAccount));

    if (!LIVE_TURN) {
      console.log('[probe] Handshake & account check passed (pass --live-turn to run read-only turn).');
      return;
    }

    if (!safeAccount.authenticated) {
      throw new Error('Codex is not authenticated. Aborting --live-turn without modifying auth.json.');
    }

    // 3. Start read-only thread
    const threadRes = await client.request('thread/start', {
      cwd: PROJECT_ROOT,
      sandbox: 'read-only',
      approvalPolicy: 'on-request',
      ephemeral: true,
      serviceName: 'ai-collab-hub-phase0',
    });

    const threadId = threadRes?.thread?.id;
    if (!threadId) {
      throw new Error(`thread/start did not return thread.id: ${JSON.stringify(threadRes)}`);
    }
    console.log('[probe] thread/start OK:', JSON.stringify({
      threadId,
      model: threadRes.model,
      modelProvider: threadRes.modelProvider,
      approvalPolicy: threadRes.approvalPolicy,
      sandboxType: threadRes.sandbox?.type ?? null,
    }));

    // 4. Run minimal read-only turn and collect streamed notifications
    let streamedDeltaText = '';
    const completedAgentMessages = [];
    const observedItemTypes = new Set();

    let resolveTurnDone;
    let rejectTurnDone;
    const turnDonePromise = new Promise((res, rej) => {
      resolveTurnDone = res;
      rejectTurnDone = rej;
    });

    const timer = setTimeout(() => {
      rejectTurnDone(new Error(`Live turn timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    let activeTurnId = null;
    const unsub = client.onNotification((method, params) => {
      if (method === 'item/started' && params?.item?.type) {
        observedItemTypes.add(params.item.type);
      } else if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
        streamedDeltaText += params.delta;
      } else if (method === 'item/completed' && params?.item) {
        observedItemTypes.add(params.item.type);
        if (params.item.type === 'agentMessage' && typeof params.item.text === 'string') {
          completedAgentMessages.push(params.item.text);
        }
      } else if (method === 'turn/completed' && params?.threadId === threadId) {
        if (!activeTurnId || params?.turn?.id === activeTurnId) {
          clearTimeout(timer);
          resolveTurnDone(params.turn);
        }
      } else if (method === 'error' && params?.threadId === threadId) {
        clearTimeout(timer);
        rejectTurnDone(new Error(`Turn error notification: ${JSON.stringify(params)}`));
      }
    });

    const turnStartRes = await client.request('turn/start', {
      threadId,
      input: [
        {
          type: 'text',
          text: 'Do not run any commands or edit any files. Reply with exactly: PHASE0_OK',
        },
      ],
    });
    activeTurnId = turnStartRes?.turn?.id ?? null;
    console.log('[probe] turn/start OK:', JSON.stringify({
      turnId: activeTurnId,
      status: turnStartRes?.turn?.status ?? null,
    }));

    const finalTurn = await turnDonePromise;
    unsub();

    const finalText = (completedAgentMessages.at(-1) ?? streamedDeltaText).trim();
    console.log('[probe] turn/completed:', JSON.stringify({
      turnId: finalTurn?.id ?? null,
      status: finalTurn?.status ?? null,
      error: finalTurn?.error ?? null,
      observedItemTypes: [...observedItemTypes],
      observedNotificationMethods: [...client.notificationMethods].sort(),
      serverRequestsCount: client.serverRequests.length,
      finalText,
    }));

    if (finalTurn?.status !== 'completed') {
      throw new Error(`Expected turn status "completed", got "${finalTurn?.status}"`);
    }
    if (finalText !== 'PHASE0_OK') {
      throw new Error(`Expected exact reply "PHASE0_OK", got ${JSON.stringify(finalText)}`);
    }
    console.log('[probe] PHASE0_LIVE_PASS');
  } finally {
    await client.close();
    if (client.stderrLines.length > 0) {
      console.log('[probe] stderr summary:', client.stderrLines.slice(0, 10).join(' | '));
    }
  }
}

main().catch((err) => {
  console.error('[probe] FAILED:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
