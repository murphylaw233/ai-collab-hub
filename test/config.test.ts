import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { loadHubConfig } from '../src/config.js';

test('loadHubConfig returns sensible defaults when no file is present', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'hub-cfg-empty-'));
  try {
    const cfg = loadHubConfig({ cwd: emptyDir, env: {} });
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 3789);
    assert.equal(cfg.dbPath, resolve(emptyDir, 'data', 'hub.sqlite'));
    assert.equal(cfg.localTokenGenerated, true);
    assert.ok(cfg.localToken.length >= 32);
    assert.equal(cfg.codex.transport, 'ws');
    assert.equal(cfg.codex.ephemeralThreads, false);
    assert.equal(cfg.codex.defaultApprovalPolicy, 'on-request');
    assert.equal(cfg.codex.defaultSandbox, 'workspace-write');
    assert.deepEqual(cfg.projects, []);
    assert.equal(cfg.remote.enabled, false);
    assert.equal(cfg.remote.port, 3790);
    assert.equal(cfg.remote.maxStateLength, 16_384);
    assert.equal(cfg.remote.allowRemoteDocsWrite, false);
    for (const prefix of [
      'https://oauth-redirect.googleusercontent.com/',
      'https://oauth-redirect-sandbox.googleusercontent.com/',
      'https://oauth-redirect-test.googleusercontent.com/',
    ]) {
      assert.ok(
        cfg.remote.allowedRedirectUriPrefixes.includes(prefix),
        `missing default redirect prefix ${prefix}`
      );
    }
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('loadHubConfig reads config file and resolves relative paths against config dir', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'hub-cfg-file-'));
  try {
    const configPath = join(workDir, 'custom.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 4100,
        localToken: 'test-token-123456',
        dbPath: './state/hub.db',
        codex: {
          transport: 'stdio',
        },
        projects: [
          {
            id: 'proj-a',
            name: 'Project A',
            rootPath: './repos/proj-a',
            permissionMode: 'codex_work',
          },
        ],
      }),
      'utf8'
    );

    const cfg = loadHubConfig({ configPath, env: {} });
    assert.equal(cfg.port, 4100);
    assert.equal(cfg.localToken, 'test-token-123456');
    assert.equal(cfg.localTokenGenerated, false);
    assert.equal(cfg.dbPath, resolve(workDir, 'state', 'hub.db'));
    assert.equal(cfg.codex.transport, 'stdio');
    assert.equal(cfg.projects.length, 1);
    assert.equal(cfg.projects[0].rootPath, resolve(workDir, 'repos', 'proj-a'));
    assert.equal(cfg.projects[0].docsSubdir, 'docs');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('loadHubConfig applies env overrides over file values', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'hub-cfg-env-'));
  try {
    const configPath = join(workDir, 'hub.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        host: '127.0.0.1',
        port: 3789,
        localToken: 'file-token-1234',
        codex: { transport: 'ws', wsPort: 4500 },
      }),
      'utf8'
    );

    const cfg = loadHubConfig({
      configPath,
      env: {
        HUB_HOST: '0.0.0.0',
        HUB_PORT: '3999',
        HUB_LOCAL_TOKEN: 'env-token-9999',
        CODEX_TRANSPORT: 'stdio',
        CODEX_WS_PORT: '4600',
      },
    });
    assert.equal(cfg.host, '0.0.0.0');
    assert.equal(cfg.port, 3999);
    assert.equal(cfg.localToken, 'env-token-9999');
    assert.equal(cfg.codex.transport, 'stdio');
    assert.equal(cfg.codex.wsPort, 4600);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('loadHubConfig rejects invalid port, duplicate project ids, and invalid permissionMode', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'hub-cfg-bad-'));
  try {
    const badPortPath = join(workDir, 'bad-port.json');
    writeFileSync(badPortPath, JSON.stringify({ port: 99999 }), 'utf8');
    assert.throws(() => loadHubConfig({ configPath: badPortPath, env: {} }));

    const dupProjPath = join(workDir, 'dup-proj.json');
    writeFileSync(
      dupProjPath,
      JSON.stringify({
        projects: [
          { id: 'dup', name: 'One', rootPath: 'D:/a', permissionMode: 'read_only' },
          { id: 'dup', name: 'Two', rootPath: 'D:/b', permissionMode: 'docs_write' },
        ],
      }),
      'utf8'
    );
    assert.throws(() => loadHubConfig({ configPath: dupProjPath, env: {} }));

    const badModePath = join(workDir, 'bad-mode.json');
    writeFileSync(
      badModePath,
      JSON.stringify({
        projects: [{ id: 'p1', name: 'Bad', rootPath: 'D:/a', permissionMode: 'admin' }],
      }),
      'utf8'
    );
    assert.throws(() => loadHubConfig({ configPath: badModePath, env: {} }));

    const remoteMissingUrl = join(workDir, 'remote-no-url.json');
    writeFileSync(
      remoteMissingUrl,
      JSON.stringify({ remote: { enabled: true, ownerPassphrase: 'super-secret-passphrase' } }),
      'utf8'
    );
    assert.throws(() => loadHubConfig({ configPath: remoteMissingUrl, env: {} }));

    const remoteShortPass = join(workDir, 'remote-short-pass.json');
    writeFileSync(
      remoteShortPass,
      JSON.stringify({
        remote: { enabled: true, publicBaseUrl: 'https://demo.ts.net', ownerPassphrase: 'short' },
      }),
      'utf8'
    );
    assert.throws(() => loadHubConfig({ configPath: remoteShortPass, env: {} }));

    const remoteSamePort = join(workDir, 'remote-same-port.json');
    writeFileSync(
      remoteSamePort,
      JSON.stringify({
        port: 3789,
        remote: {
          enabled: true,
          port: 3789,
          publicBaseUrl: 'https://demo.ts.net',
          ownerPassphrase: 'super-secret-passphrase',
        },
      }),
      'utf8'
    );
    assert.throws(() => loadHubConfig({ configPath: remoteSamePort, env: {} }));

    const validRemote = join(workDir, 'remote-valid.json');
    writeFileSync(
      validRemote,
      JSON.stringify({
        remote: {
          enabled: true,
          port: 3790,
          publicBaseUrl: 'https://demo.ts.net/',
          ownerPassphrase: 'super-secret-passphrase',
        },
      }),
      'utf8'
    );
    const parsedRemote = loadHubConfig({ configPath: validRemote, env: {} });
    assert.equal(parsedRemote.remote.enabled, true);
    assert.equal(parsedRemote.remote.publicBaseUrl, 'https://demo.ts.net');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
