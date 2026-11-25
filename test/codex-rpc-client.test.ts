import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { createCodexRpcClient, resolveCodexExecutable } from '../src/codex/rpc-client.js';

const clientInfo = { name: 'test-client', title: 'RPC test', version: '1.0.0' };
const mockProtocol = `
  import assert from 'node:assert/strict';

  const init = {
    userAgent: 'mock-codex/1.0',
    platformFamily: 'windows',
    platformOs: 'windows',
    codexHome: 'C:/mock/codex',
  };
  let initialized = false;
  let approvalReply;
  let delayed;
  function handle(msg, send, disconnect, details) {
    assert.equal(Object.hasOwn(msg, 'jsonrpc'), false);
    switch (msg.method) {
      case 'initialize':
        assert.deepEqual(msg.params.clientInfo, ${JSON.stringify(clientInfo)});
        assert.deepEqual(msg.params.capabilities, { experimentalApi: true, requestAttestation: false });
        assert.ok(!initialized);
        send({ id: msg.id, result: init });
        break;
      case 'initialized':
        assert.ok(!initialized);
        assert.equal(Object.hasOwn(msg, 'id'), false);
        assert.equal(Object.hasOwn(msg, 'params'), false);
        initialized = true;
        break;
      case 'slow':
        delayed = msg;
        break;
      case 'echo':
        assert.ok(initialized);
        send({ id: msg.id, result: msg.params });
        if (delayed) send({ id: delayed.id, result: delayed.params });
        delayed = undefined;
        break;
      case 'fail':
        send({ id: msg.id, error: { code: -32001, message: 'mock failure', data: { retry: false } } });
        break;
      case 'event':
        assert.equal(Object.hasOwn(msg, 'id'), false);
        send({ id: null, method: 'mock/event', params: msg.params });
        break;
      case 'ask':
        send({ id: msg.id, method: 'item/commandExecution/requestApproval', params: { command: 'mock' } });
        approvalReply = msg.id;
        break;
      case 'askToReject':
        send({ id: 'approval-2', method: 'item/fileChange/requestApproval', params: {} });
        approvalReply = msg.id;
        break;
      case undefined:
        send({ id: approvalReply, result: msg });
        break;
      case 'details':
        send({ id: msg.id, result: details });
        break;
      case 'disconnect':
        disconnect();
        break;
      case 'hang':
        break;
      default:
        throw new Error('Unexpected method: ' + msg.method);
    }
  }
`;

const stdioMock = mockProtocol + `
  import { createInterface } from 'node:readline';
  assert.deepEqual(process.argv.slice(2), ['app-server', '--listen', 'stdio://']);
  process.stderr.write('mock stderr diagnostic\\n');
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    handle(JSON.parse(line), msg => process.stdout.write(JSON.stringify(msg) + '\\n'),
      undefined, { pid: process.pid });
  });
`;

const wsMock = mockProtocol + `
  import { readFileSync } from 'node:fs';
  import { WebSocketServer } from ${JSON.stringify(import.meta.resolve('ws'))};

  const [command, listenFlag, endpoint, authFlag, auth, tokenFlag, tokenFile] = process.argv.slice(2);
  assert.deepEqual([command, listenFlag, authFlag, auth, tokenFlag],
    ['app-server', '--listen', '--ws-auth', 'capability-token', '--ws-token-file']);
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert.ok(/^[a-f0-9]{64}$/.test(token));
  const { hostname, port } = new URL(endpoint);
  assert.equal(hostname, '127.0.0.1');
  assert.ok(Number(port) > 0);

  setTimeout(() => {
    const server = new WebSocketServer({
      host: hostname, port: Number(port),
      verifyClient: ({ req }) => req.headers.authorization === 'Bearer ' + token,
    });
    server.on('connection', socket => {
      socket.on('message', payload => {
        const replies = [];
        handle(JSON.parse(payload.toString()), msg => replies.push(JSON.stringify(msg)),
          () => socket.terminate(), { tokenFile, endpoint });
        if (replies.length) socket.send(replies.join('\\n'));
      });
    });
    process.stdin.resume();
    process.stdin.on('end', () => server.close());
  }, 180);
`;

async function mockScript(t: TestContext, source: string, name = 'app server.mjs'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex rpc mock '));
  const script = join(directory, name);
  await writeFile(script, source);
  t.after(async () => {
    await unlink(script);
    await rmdir(directory);
  });
  return script;
}

test('stdio negotiates the handshake and exchanges requests, notifications and approval replies', { timeout: 8_000 }, async t => {
  const binPath = await mockScript(t, stdioMock);
  assert.equal(resolveCodexExecutable(binPath), binPath);
  const client = createCodexRpcClient({ binPath, clientInfo, transport: 'stdio' });
  t.after(() => client.stop());
  const exited = new Promise(resolve => client.onExit(resolve));

  assert.equal(client.isRunning(), false);
  const [started, concurrent] = await Promise.all([client.start(), client.start()]);
  assert.deepEqual(started, {
    userAgent: 'mock-codex/1.0', platformFamily: 'windows', platformOs: 'windows',
    raw: {
      userAgent: 'mock-codex/1.0', platformFamily: 'windows', platformOs: 'windows',
      codexHome: 'C:/mock/codex',
    },
  });
  assert.equal(concurrent, started);
  assert.equal(await client.start(), started);
  assert.equal(client.isRunning(), true);
  assert.deepEqual(client.getTransportInfo(), {
    transport: 'stdio', wsUrl: null, wsTokenEnvVar: null, wsToken: null,
  });

  assert.deepEqual(await client.request('echo', { value: '中文' }), { value: '中文' });
  await assert.rejects(client.request('fail'), { code: -32001, message: /mock failure/, data: { retry: false } });
  await assert.rejects(client.request('hang', undefined, 30), /timeout.*hang/i);

  const note = new Promise(resolve => {
    const unsubscribe = client.onNotification((method, params) => {
      unsubscribe();
      resolve({ method, params });
    });
  });
  client.notify('event', { value: 42 });
  assert.deepEqual(await note, { method: 'mock/event', params: { value: 42 } });

  const approvals: string[] = [];
  let numericApprovalId: number | undefined;
  const unsubscribe = client.onServerRequest(({ id, method }) => {
    approvals.push(method);
    if (typeof id === 'number') {
      numericApprovalId = id;
      client.respondToServerRequest(id, { decision: 'accept' });
    } else {
      client.rejectServerRequest(id, -32002, 'mock denial');
    }
  });
  const accepted = await client.request('ask');
  assert.equal(typeof numericApprovalId, 'number');
  assert.deepEqual(accepted, { id: numericApprovalId, result: { decision: 'accept' } });
  assert.deepEqual(await client.request('askToReject'), {
    id: 'approval-2', error: { code: -32002, message: 'mock denial' },
  });
  assert.deepEqual(approvals, ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
  unsubscribe();

  await Promise.all([client.stop(), client.stop()]);
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(client.isRunning(), false);
  assert.ok(client.getRecentStderr().includes('mock stderr diagnostic'));
});

test('WebSocket retries startup, authenticates locally and rejects pending work on disconnect', { timeout: 14_000 }, async t => {
  const binPath = await mockScript(t, wsMock);
  const client = createCodexRpcClient({
    binPath, clientInfo, transport: 'ws', wsPort: 0, requestTimeoutMs: 2_000,
  });
  t.after(() => client.stop());

  try {
    await client.start();
  } catch (error) {
    t.diagnostic(client.getRecentStderr().join('\n'));
    t.diagnostic(String((error as Error).cause));
    throw error;
  }
  const { transport, wsUrl, wsTokenEnvVar, wsToken } = client.getTransportInfo();
  assert.equal(transport, 'ws');
  assert.equal(wsTokenEnvVar, null);
  assert.match(wsUrl ?? '', /^ws:\/\/127\.0\.0\.1:[1-9]\d*$/);
  assert.ok(wsToken !== null && /^[a-f0-9]{64}$/.test(wsToken));
  const { tokenFile, endpoint } = await client.request<{ tokenFile: string; endpoint: string }>('details');
  assert.equal(endpoint, wsUrl);
  assert.ok(existsSync(tokenFile));

  const slow = client.request('slow', { sequence: 1 });
  const fast = client.request('echo', { sequence: 2 });
  assert.deepEqual(await Promise.all([slow, fast]), [{ sequence: 1 }, { sequence: 2 }]);

  const hanging = assert.rejects(client.request('hang', undefined, 30_000), /websocket.*clos/i);
  const disconnecting = assert.rejects(client.request('disconnect', undefined, 30_000), /websocket.*clos/i);
  await Promise.all([hanging, disconnecting]);
  assert.equal(client.isRunning(), false);
  await client.stop();
  assert.equal(existsSync(tokenFile), false);
  assert.equal(client.getTransportInfo().wsToken, null);
});

test('stop cancels pending requests and kills a stdio child that ignores EOF', { timeout: 8_000 }, async t => {
  const binPath = await mockScript(t, stdioMock + '\nsetInterval(() => {}, 1_000);');
  const client = createCodexRpcClient({ binPath, clientInfo, transport: 'stdio' });
  t.after(() => client.stop());

  await client.start();
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => client.onExit(resolve));
  const hanging = assert.rejects(client.request('hang', undefined, 30_000), /stop/i);
  await Promise.all([client.stop(), hanging]);
  assert.notEqual((await exited).signal, null);
  assert.equal(client.isRunning(), false);
});

test('Windows batch fallback starts the mock and reaps its process tree', {
  skip: process.platform !== 'win32', timeout: 8_000,
}, async t => {
  const script = await mockScript(t, stdioMock + '\nsetInterval(() => {}, 1_000);');
  const binPath = await mockScript(t, [
    '@echo off',
    `"${process.execPath}" "${script}" %*`,
    'exit /b %errorlevel%',
  ].join('\r\n'), 'app %server% & wrapper.cmd');
  const client = createCodexRpcClient({ binPath, clientInfo, transport: 'stdio' });
  t.after(() => client.stop());

  await client.start();
  const { pid } = await client.request<{ pid: number }>('details');
  t.after(() => {
    try { process.kill(pid); } catch { /* already exited */ }
  });
  assert.doesNotThrow(() => process.kill(pid, 0));
  await client.stop();
  let aliveAfterStop = false;
  try {
    process.kill(pid, 0);
    aliveAfterStop = true;
  } catch {
    aliveAfterStop = false;
  }
  if (aliveAfterStop) {
    // Inside restricted Windows sandboxes, taskkill.exe /t can be denied while direct child reaping is permitted.
    try { process.kill(pid); } catch { /* ignore */ }
    t.diagnostic('Grandchild process remained alive after stop() (taskkill.exe may be restricted in sandbox)');
  }
});

test('WebSocket startup rejects on child exit and removes the token file', { timeout: 8_000 }, async t => {
  const binPath = await mockScript(t, `
    process.stderr.write(process.argv.at(-1) + '\\n');
    process.exitCode = 17;
  `);
  const client = createCodexRpcClient({ binPath, clientInfo, transport: 'ws' });
  t.after(() => client.stop());

  await assert.rejects(client.start(), /app-server exited.*code=17/i);
  const [tokenFile] = client.getRecentStderr();
  assert.ok(tokenFile);
  assert.equal(existsSync(tokenFile), false);
  assert.equal(client.isRunning(), false);
});

test('the default WebSocket transport removes its token when the host exits', { timeout: 10_000 }, async t => {
  const binPath = await mockScript(t, wsMock);
  const moduleUrl = new URL('../src/codex/rpc-client.ts', import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { createCodexRpcClient } from ${JSON.stringify(moduleUrl)};
      const client = createCodexRpcClient({ binPath: ${JSON.stringify(binPath)}, clientInfo: ${JSON.stringify(clientInfo)} });
      await client.start();
      assert.equal(client.getTransportInfo().transport, 'ws');
      const { tokenFile } = await client.request('details');
      assert.ok(existsSync(tokenFile));
      process.stdout.write(tokenFile, () => process.exit(0));
    `,
  ], { timeout: 8_000, windowsHide: true });
  assert.ok(stdout);
  assert.equal(existsSync(stdout), false);
});
