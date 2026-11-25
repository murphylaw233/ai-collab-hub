import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const HUB_CONFIG_PATH = join(PROJECT_ROOT, 'config', 'hub.json');
const PLUGIN_SRC_DIR = join(PROJECT_ROOT, 'plugin', 'ai-collab-hub');
const PLUGIN_DEST_DIR = join(homedir(), '.gemini', 'config', 'plugins', 'ai-collab-hub');

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function tokenFingerprint(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 10);
}

function main() {
  ensureDir(dirname(HUB_CONFIG_PATH));

  let hubConfig;
  let createdConfig = false;
  if (existsSync(HUB_CONFIG_PATH)) {
    hubConfig = JSON.parse(readFileSync(HUB_CONFIG_PATH, 'utf8'));
    if (!hubConfig.localToken || typeof hubConfig.localToken !== 'string' || hubConfig.localToken.length < 16) {
      hubConfig.localToken = randomBytes(32).toString('hex');
      writeFileSync(HUB_CONFIG_PATH, JSON.stringify(hubConfig, null, 2) + '\n', 'utf8');
    }
  } else {
    createdConfig = true;
    hubConfig = {
      host: '127.0.0.1',
      port: 3789,
      localToken: randomBytes(32).toString('hex'),
      dbPath: 'data/hub.sqlite',
      codex: {
        transport: 'ws',
        wsPort: 0,
        defaultApprovalPolicy: 'on-request',
        defaultSandbox: 'workspace-write',
        ephemeralThreads: false,
      },
      guardrails: {
        idempotencyCooldownMs: 60000,
        maxTaskDurationMs: 600000,
        maxFollowupTurns: 6,
        maxConsecutiveErrors: 3,
        maxCommandOutputBytes: 65536,
        deltaFlushIntervalMs: 100,
      },
      projects: [
        {
          id: 'ai-collab-hub',
          name: 'AI Collab Hub',
          rootPath: PROJECT_ROOT.replace(/\\/g, '/'),
          permissionMode: 'codex_work',
          docsSubdir: 'docs',
          description: 'Local AI Collab Hub repository',
        },
      ],
    };
    writeFileSync(HUB_CONFIG_PATH, JSON.stringify(hubConfig, null, 2) + '\n', 'utf8');
  }

  ensureDir(PLUGIN_DEST_DIR);
  ensureDir(join(PLUGIN_DEST_DIR, 'rules'));
  ensureDir(join(PLUGIN_DEST_DIR, 'skills', 'codex-collab', 'scripts'));
  ensureDir(join(PLUGIN_DEST_DIR, 'skills', 'collab-orchestrator'));

  copyFileSync(join(PLUGIN_SRC_DIR, 'plugin.json'), join(PLUGIN_DEST_DIR, 'plugin.json'));
  copyFileSync(join(PLUGIN_SRC_DIR, 'rules', 'AGENTS.md'), join(PLUGIN_DEST_DIR, 'rules', 'AGENTS.md'));
  const skillWaiterScript = join(PLUGIN_DEST_DIR, 'skills', 'codex-collab', 'scripts', 'hub-wait-done.mjs');
  const codexCollabSkill = readFileSync(join(PLUGIN_SRC_DIR, 'skills', 'codex-collab', 'SKILL.md'), 'utf8').replaceAll(
    '$env:USERPROFILE\\.gemini\\config\\plugins\\ai-collab-hub\\skills\\codex-collab\\scripts\\hub-wait-done.mjs',
    skillWaiterScript
  );
  writeFileSync(join(PLUGIN_DEST_DIR, 'skills', 'codex-collab', 'SKILL.md'), codexCollabSkill, 'utf8');
  copyFileSync(
    join(PROJECT_ROOT, 'scripts', 'hub-wait-done.mjs'),
    join(PLUGIN_DEST_DIR, 'skills', 'codex-collab', 'scripts', 'hub-wait-done.mjs')
  );
  copyFileSync(
    join(PLUGIN_SRC_DIR, 'skills', 'collab-orchestrator', 'SKILL.md'),
    join(PLUGIN_DEST_DIR, 'skills', 'collab-orchestrator', 'SKILL.md')
  );

  const host = hubConfig.host || '127.0.0.1';
  const port = hubConfig.port || 3789;
  const mcpConfig = {
    mcpServers: {
      'ai-collab-hub': {
        url: `http://${host}:${port}/mcp/local`,
        headers: {
          Authorization: `Bearer ${hubConfig.localToken}`,
        },
      },
    },
  };
  writeFileSync(join(PLUGIN_DEST_DIR, 'mcp_config.json'), JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');

  console.log('[setup-local] config/hub.json:', createdConfig ? 'CREATED' : 'UPDATED/PRESERVED');
  console.log('[setup-local] plugin installed at:', PLUGIN_DEST_DIR);
  console.log('[setup-local] localToken length:', hubConfig.localToken.length, 'sha256_prefix:', tokenFingerprint(hubConfig.localToken));
}

main();
