import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { HubConfig, ProjectConfig } from './types.js';

export const ProjectConfigSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'Project id must be non-empty')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Project id must match /^[a-zA-Z0-9_-]+$/'),
  name: z.string().trim().min(1, 'Project name must be non-empty'),
  rootPath: z.string().trim().min(1, 'Project rootPath must be non-empty'),
  permissionMode: z.enum(['read_only', 'docs_write', 'codex_work']).default('read_only'),
  docsSubdir: z.string().trim().min(1).default('docs'),
  description: z.string().optional(),
});

const CodexConfigSchema = z.object({
  binPath: z.string().trim().min(1).optional(),
  transport: z.enum(['stdio', 'ws']).default('ws'),
  wsPort: z.number().int().min(0).max(65535).default(0),
  defaultModel: z.string().trim().min(1).optional(),
  defaultApprovalPolicy: z.enum(['on-request', 'untrusted', 'never']).default('on-request'),
  defaultSandbox: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .default('workspace-write'),
  ephemeralThreads: z.boolean().default(false),
});

const GuardrailsConfigSchema = z.object({
  idempotencyCooldownMs: z.number().int().min(0).default(60_000),
  maxTaskDurationMs: z.number().int().min(5_000).default(600_000),
  maxFollowupTurns: z.number().int().min(1).max(50).default(6),
  maxConsecutiveErrors: z.number().int().min(1).max(20).default(3),
  maxCommandOutputBytes: z.number().int().min(1_024).default(65_536),
  deltaFlushIntervalMs: z.number().int().min(20).max(5_000).default(100),
});

const DEFAULT_REDIRECT_URI_PREFIXES = [
  'https://oauth-redirect.googleusercontent.com/',
  'https://oauth-redirect-sandbox.googleusercontent.com/',
  'https://oauth-redirect-test.googleusercontent.com/',
  'https://vertexaisearch.cloud.google.com/oauth-redirect',
  'https://antigravity.google/oauth-callback',
  'https://gemini.google.com/',
  'http://127.0.0.1:',
  'http://localhost:',
];

const RemoteStaticClientSchema = z.object({
  clientId: z.string().trim().min(4),
  clientSecret: z.string().trim().min(8).optional(),
  redirectUris: z.array(z.string().trim().url()).min(1),
});

const RemoteGatewayConfigSchema = z.object({
  enabled: z.boolean().default(false),
  host: z.string().trim().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(3790),
  publicBaseUrl: z.string().trim().min(1).optional(),
  ownerPassphrase: z.string().optional(),
  staticClient: RemoteStaticClientSchema.optional(),
  allowedRedirectUriPrefixes: z
    .array(z.string().trim().min(1))
    .default(() => [...DEFAULT_REDIRECT_URI_PREFIXES]),
  accessTokenTtlSec: z.number().int().min(60).max(86_400).default(3600),
  refreshTokenTtlSec: z.number().int().min(300).max(31_536_000).default(2_592_000),
  maxStateLength: z.number().int().min(4096).max(65_536).default(16_384),
  allowRemoteDocsWrite: z.boolean().default(false),
});

const RawHubConfigSchema = z
  .object({
    host: z.string().trim().min(1).default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(3789),
    localToken: z.string().trim().min(8).optional(),
    dbPath: z.string().trim().min(1).default('data/hub.sqlite'),
    projects: z.array(ProjectConfigSchema).default([]),
    codex: CodexConfigSchema.default(() => CodexConfigSchema.parse({})),
    guardrails: GuardrailsConfigSchema.default(() => GuardrailsConfigSchema.parse({})),
    remote: RemoteGatewayConfigSchema.default(() => RemoteGatewayConfigSchema.parse({})),
  })
  .superRefine((val, ctx) => {
    const seenIds = new Set<string>();
    for (let i = 0; i < val.projects.length; i++) {
      const id = val.projects[i].id;
      if (seenIds.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['projects', i, 'id'],
          message: `Duplicate project id: ${id}`,
        });
      }
      seenIds.add(id);
    }

    if (val.remote.enabled) {
      if (val.remote.port === val.port) {
        ctx.addIssue({
          code: 'custom',
          path: ['remote', 'port'],
          message: 'remote.port must differ from local hub port for dual-port isolation',
        });
      }
      if (!val.remote.publicBaseUrl) {
        ctx.addIssue({
          code: 'custom',
          path: ['remote', 'publicBaseUrl'],
          message: 'remote.publicBaseUrl is required when remote.enabled is true',
        });
      } else {
        let parsedUrl: URL | null = null;
        try {
          parsedUrl = new URL(val.remote.publicBaseUrl);
        } catch {
          parsedUrl = null;
        }
        const isLoopbackHttp =
          parsedUrl?.protocol === 'http:' &&
          (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost');
        if (!parsedUrl || (parsedUrl.protocol !== 'https:' && !isLoopbackHttp)) {
          ctx.addIssue({
            code: 'custom',
            path: ['remote', 'publicBaseUrl'],
            message: 'remote.publicBaseUrl must be an https:// URL (or loopback http:// for local tests)',
          });
        }
      }
      if (!val.remote.ownerPassphrase || val.remote.ownerPassphrase.length < 12) {
        ctx.addIssue({
          code: 'custom',
          path: ['remote', 'ownerPassphrase'],
          message: 'remote.ownerPassphrase must be at least 12 characters when remote.enabled is true',
        });
      }
    }
  });

export interface LoadHubConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

function parseIntEnv(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid integer in env ${name}: ${value}`);
  }
  return n;
}

export function loadHubConfig(options: LoadHubConfigOptions = {}): HubConfig {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const requestedConfigPath = options.configPath ?? env.HUB_CONFIG_PATH;

  let rawFromFile: Record<string, unknown> = {};
  let baseDir = cwd;
  let loadedConfigPath: string | undefined;

  if (requestedConfigPath) {
    const resolvedConfigPath = isAbsolute(requestedConfigPath)
      ? requestedConfigPath
      : resolve(cwd, requestedConfigPath);
    if (!existsSync(resolvedConfigPath)) {
      throw new Error(`Config file not found: ${resolvedConfigPath}`);
    }
    const text = readFileSync(resolvedConfigPath, 'utf8');
    const parsedJson = JSON.parse(text);
    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new Error(`Config file must contain a JSON object: ${resolvedConfigPath}`);
    }
    rawFromFile = parsedJson as Record<string, unknown>;
    baseDir = dirname(resolvedConfigPath);
    loadedConfigPath = resolvedConfigPath;
  } else {
    const defaultConfigPath = resolve(cwd, 'config', 'hub.json');
    if (existsSync(defaultConfigPath)) {
      const text = readFileSync(defaultConfigPath, 'utf8');
      const parsedJson = JSON.parse(text);
      if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
        throw new Error(`Config file must contain a JSON object: ${defaultConfigPath}`);
      }
      rawFromFile = parsedJson as Record<string, unknown>;
      baseDir = cwd;
      loadedConfigPath = defaultConfigPath;
    }
  }

  const fileCodex =
    rawFromFile.codex && typeof rawFromFile.codex === 'object' && !Array.isArray(rawFromFile.codex)
      ? (rawFromFile.codex as Record<string, unknown>)
      : {};
  const fileRemote =
    rawFromFile.remote && typeof rawFromFile.remote === 'object' && !Array.isArray(rawFromFile.remote)
      ? (rawFromFile.remote as Record<string, unknown>)
      : {};

  const parseBoolEnv = (value: string | undefined): boolean | undefined => {
    if (value === undefined || value.trim() === '') return undefined;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`Invalid boolean env value: ${value}`);
  };

  const remoteEnabledEnv = parseBoolEnv(env.HUB_REMOTE_ENABLED);
  const remoteAllowDocsEnv = parseBoolEnv(env.HUB_REMOTE_ALLOW_DOCS_WRITE);
  const remotePortEnv = parseIntEnv(env.HUB_REMOTE_PORT, 'HUB_REMOTE_PORT');

  const merged: Record<string, unknown> = {
    ...rawFromFile,
    codex: {
      ...fileCodex,
      ...(env.CODEX_BIN ? { binPath: env.CODEX_BIN } : {}),
      ...(env.CODEX_TRANSPORT ? { transport: env.CODEX_TRANSPORT } : {}),
      ...(parseIntEnv(env.CODEX_WS_PORT, 'CODEX_WS_PORT') !== undefined
        ? { wsPort: parseIntEnv(env.CODEX_WS_PORT, 'CODEX_WS_PORT') }
        : {}),
    },
    remote: {
      ...fileRemote,
      ...(remoteEnabledEnv !== undefined ? { enabled: remoteEnabledEnv } : {}),
      ...(env.HUB_REMOTE_HOST ? { host: env.HUB_REMOTE_HOST } : {}),
      ...(remotePortEnv !== undefined ? { port: remotePortEnv } : {}),
      ...(env.HUB_PUBLIC_BASE_URL ? { publicBaseUrl: env.HUB_PUBLIC_BASE_URL } : {}),
      ...(env.HUB_OWNER_PASSPHRASE ? { ownerPassphrase: env.HUB_OWNER_PASSPHRASE } : {}),
      ...(remoteAllowDocsEnv !== undefined ? { allowRemoteDocsWrite: remoteAllowDocsEnv } : {}),
    },
  };

  if (env.HUB_HOST) merged.host = env.HUB_HOST;
  const envPort = parseIntEnv(env.HUB_PORT, 'HUB_PORT');
  if (envPort !== undefined) merged.port = envPort;
  if (env.HUB_LOCAL_TOKEN) merged.localToken = env.HUB_LOCAL_TOKEN;
  if (env.HUB_DB_PATH) merged.dbPath = env.HUB_DB_PATH;

  const validated = RawHubConfigSchema.parse(merged);

  const resolvedDbPath = isAbsolute(validated.dbPath)
    ? validated.dbPath
    : resolve(baseDir, validated.dbPath);

  const resolvedProjects: ProjectConfig[] = validated.projects.map((p) => ({
    ...p,
    rootPath: isAbsolute(p.rootPath) ? resolve(p.rootPath) : resolve(baseDir, p.rootPath),
  }));

  const localTokenGenerated = !validated.localToken;
  const localToken = validated.localToken ?? randomBytes(24).toString('hex');

  const normalizedRemote = {
    ...validated.remote,
    publicBaseUrl: validated.remote.publicBaseUrl?.replace(/\/+$/, ''),
  };

  return {
    host: validated.host,
    port: validated.port,
    localToken,
    localTokenGenerated,
    configPath: loadedConfigPath,
    dbPath: resolvedDbPath,
    projects: resolvedProjects,
    codex: validated.codex,
    guardrails: validated.guardrails,
    remote: normalizedRemote,
  };
}

function isSameOrSubpath(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeRealpath(dirPath: string): string {
  try {
    return realpathSync(dirPath);
  } catch {
    return resolve(dirPath);
  }
}

export function validateProjectRootForRegistration(rootPath: string): string {
  const trimmed = rootPath.trim();
  if (!trimmed || !isAbsolute(trimmed)) {
    throw new Error(`Project rootPath must be an absolute path: "${rootPath}"`);
  }
  const resolved = resolve(trimmed);
  if (!existsSync(resolved)) {
    throw new Error(`Project rootPath does not exist: "${resolved}"`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Project rootPath must be an existing directory: "${resolved}"`);
  }

  const real = safeRealpath(resolved);
  const parsedRoot = parse(real).root;
  if (real.toLowerCase() === parsedRoot.toLowerCase()) {
    throw new Error(`Refusing to register filesystem/drive root as a project: "${real}"`);
  }

  const home = safeRealpath(homedir());
  const homeParent = dirname(home);
  if (
    real.toLowerCase() === home.toLowerCase() ||
    real.toLowerCase() === homeParent.toLowerCase()
  ) {
    throw new Error(`Refusing to register user home or parent directory as a project: "${real}"`);
  }

  const blockedTrees = [
    join(home, '.codex'),
    join(home, '.ssh'),
    join(home, '.gemini'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
  ]
    .filter((entry): entry is string => Boolean(entry && entry.trim()))
    .map((entry) => safeRealpath(entry));

  const tempRoot = safeRealpath(tmpdir());
  for (const blocked of blockedTrees) {
    if (isSameOrSubpath(blocked, real)) {
      // Allow OS temp subdirectories (e.g. %LOCALAPPDATA%\Temp on Windows) used by sandboxes/tests
      if (isSameOrSubpath(tempRoot, real) && tempRoot.toLowerCase() !== blocked.toLowerCase()) {
        continue;
      }
      throw new Error(`Refusing to register protected/sensitive directory as a project: "${real}"`);
    }
  }

  return real;
}

export function upsertProjectInConfigFile(
  configPath: string,
  project: ProjectConfig,
  overwrite: boolean
): { created: boolean; project: ProjectConfig } {
  const validated = ProjectConfigSchema.parse(project);
  const rawText = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config JSON object in ${configPath}`);
  }
  const configObj = parsed as Record<string, unknown>;
  const existingProjects = Array.isArray(configObj.projects)
    ? [...(configObj.projects as Array<Record<string, unknown>>)]
    : [];

  const idx = existingProjects.findIndex((p) => p && p.id === validated.id);
  const created = idx === -1;
  if (!created && !overwrite) {
    throw new Error(`Project "${validated.id}" already exists in config (set overwrite=true to update)`);
  }

  const normalizedEntry: ProjectConfig = {
    ...validated,
    rootPath: validated.rootPath.replace(/\\/g, '/'),
  };

  if (created) {
    existingProjects.push(normalizedEntry as unknown as Record<string, unknown>);
  } else {
    existingProjects[idx] = normalizedEntry as unknown as Record<string, unknown>;
  }

  configObj.projects = existingProjects;
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(configObj, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, configPath);

  return { created, project: normalizedEntry };
}

export function removeProjectFromConfigFile(configPath: string, projectId: string): boolean {
  const rawText = readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config JSON object in ${configPath}`);
  }
  const configObj = parsed as Record<string, unknown>;
  const existingProjects = Array.isArray(configObj.projects)
    ? (configObj.projects as Array<Record<string, unknown>>)
    : [];

  const nextProjects = existingProjects.filter((p) => !p || p.id !== projectId);
  if (nextProjects.length === existingProjects.length) {
    return false;
  }

  configObj.projects = nextProjects;
  const tmpPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(configObj, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, configPath);
  return true;
}
