import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

function resolveCodexExe() {
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  const archDir = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const pkgDir = process.arch === 'arm64' ? 'codex-win32-arm64' : 'codex-win32-x64';
  const nativeExe = join(PROJECT_ROOT, 'node_modules', '@openai', pkgDir, 'vendor', archDir, 'bin', 'codex.exe');
  if (existsSync(nativeExe)) {
    return nativeExe;
  }
  throw new Error(`Native codex.exe not found at ${nativeExe}`);
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => rejectPort(new Error('Failed to get ephemeral port')));
        return;
      }
      const { port } = addr;
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

function connectWsWithRetry(url, token, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWs, rejectWs) => {
    const tryOnce = () => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const onError = (err) => {
        ws.removeAllListeners();
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        if (Date.now() < deadline) {
          setTimeout(tryOnce, 200);
        } else {
          rejectWs(err);
        }
      };
      ws.once('error', onError);
      ws.once('open', () => {
        ws.off('error', onError);
        resolveWs(ws);
      });
    };
    tryOnce();
  });
}

function createWsRpcClient(ws) {
  let nextId = 1;
  const pending = new Map();

  ws.on('message', (data) => {
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const hasId = msg.id !== undefined && msg.id !== null;
      const hasMethod = typeof msg.method === 'string';
      if (hasId && !hasMethod) {
        const entry = pending.get(msg.id);
        if (!entry) continue;
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(`RPC error (${msg.error.code}): ${msg.error.message}`));
        } else {
          entry.resolve(msg.result);
        }
      }
    }
  });

  ws.on('close', () => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('WebSocket closed'));
    }
    pending.clear();
  });

  return {
    request(method, params, timeoutMs = 15_000) {
      const id = nextId++;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rej(new Error(`RPC timeout for ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve: res, reject: rej, timer });
        const payload = params === undefined ? { id, method } : { id, method, params };
        ws.send(JSON.stringify(payload));
      });
    },
    notify(method, params) {
      const payload = params === undefined ? { method } : { method, params };
      ws.send(JSON.stringify(payload));
    },
    close() {
      return new Promise((res) => {
        if (ws.readyState === WebSocket.CLOSED) return res();
        ws.once('close', () => res());
        ws.close();
        setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            // ignore
          }
          res();
        }, 1000);
      });
    },
  };
}

async function main() {
  const codexExe = resolveCodexExe();
  const port = await getFreePort();
  const token = randomBytes(32).toString('hex');
  const tokenFile = join(tmpdir(), `codex-ws-token-${process.pid}-${Date.now()}.txt`);
  writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 });

  const wsUrl = `ws://127.0.0.1:${port}`;
  const stderrLines = [];
  const child = spawn(
    codexExe,
    [
      'app-server',
      '--listen',
      wsUrl,
      '--ws-auth',
      'capability-token',
      '--ws-token-file',
      tokenFile,
    ],
    {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  child.stderr.on('data', (chunk) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim()) stderrLines.push(line.trim());
    }
  });

  let rpc1 = null;
  let rpc2 = null;

  const summary = {
    wsSupported: false,
    multiClientSupported: false,
    client1AuthType: null,
    client2Ok: false,
    error: null,
  };

  try {
    const ws1 = await connectWsWithRetry(wsUrl, token, 10_000);
    rpc1 = createWsRpcClient(ws1);

    await rpc1.request('initialize', {
      clientInfo: {
        name: 'ai-collab-hub-ws-probe-1',
        title: 'AI Collab Hub WS Probe Client 1',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    rpc1.notify('initialized');
    const acct1 = await rpc1.request('account/read', { refreshToken: false });
    summary.wsSupported = true;
    summary.client1AuthType = acct1?.account?.type ?? null;

    // Attempt second concurrent WS client while Client 1 stays open
    try {
      const ws2 = await connectWsWithRetry(wsUrl, token, 5_000);
      rpc2 = createWsRpcClient(ws2);
      await rpc2.request('initialize', {
        clientInfo: {
          name: 'ai-collab-hub-ws-probe-2',
          title: 'AI Collab Hub WS Probe Client 2',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      rpc2.notify('initialized');
      const acct2 = await rpc2.request('account/read', { refreshToken: false });
      summary.client2Ok = Boolean(acct2?.account);
      summary.multiClientSupported = summary.client2Ok;
    } catch (err2) {
      summary.multiClientSupported = false;
      summary.client2Ok = false;
      summary.error = `Client 2 failed: ${err2?.message || String(err2)}`;
    }
  } catch (err1) {
    summary.error = err1?.message || String(err1);
  } finally {
    if (rpc2) await rpc2.close();
    if (rpc1) await rpc1.close();
    if (!child.killed && child.exitCode === null) {
      child.kill();
      await new Promise((res) => {
        child.once('exit', () => res());
        setTimeout(res, 2000);
      });
    }
    try {
      if (existsSync(tokenFile)) unlinkSync(tokenFile);
    } catch {
      // ignore
    }
  }

  console.log('[ws-probe] summary:', JSON.stringify(summary));
  if (stderrLines.length > 0) {
    console.log('[ws-probe] stderr:', stderrLines.slice(0, 8).join(' | '));
  }
  if (!summary.wsSupported) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[ws-probe] FAILED:', err?.stack || err?.message || err);
  process.exitCode = 1;
});
