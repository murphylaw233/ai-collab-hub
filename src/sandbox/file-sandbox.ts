import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, opendir, realpath, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
  DirListResult,
  GitDiffResult,
  IFileSandbox,
  ProjectConfig,
  ProjectSummary,
  ReadLinesResult,
  SearchFilesResult,
  WriteDocResult,
} from '../types.js';

const runGit = promisify(execFile);
const ignoredDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']);
const docExtensions = new Set(['.md', '.txt', '.json', '.yaml', '.yml']);
const sensitiveNames = ['auth.json', 'credentials.json', '.npmrc', '.pypirc'];
const sensitivePrefixes = ['id_rsa', 'id_ed25519'];
const sensitiveExtensions = ['.key', '.pem', '.p12', '.pfx', '.jks'];
const gitSensitiveFiles = ['config', 'credentials'];
const binaryProbeBytes = 8192;
const maxSearchFileBytes = 1024 * 1024;

function sensitivePath(relativePath: string): boolean {
  const parts = relativePath.toLowerCase().split('/');
  return parts.some((name, index) =>
    (name.startsWith('.env') && name !== '.env.example' && name !== '.env.sample')
    || sensitiveNames.includes(name)
    || sensitivePrefixes.some((prefix) => name.startsWith(prefix))
    || sensitiveExtensions.some((extension) => name.endsWith(extension))
    || (parts[index - 1] === '.git' && gitSensitiveFiles.includes(name))
  );
}

function skippedDirectory(relativePath: string): boolean {
  return relativePath.toLowerCase().split('/').some((name) => ignoredDirectories.has(name));
}

function validPathSegment(name: string): boolean {
  if (name === '.' || name === '..') return true;
  return !/[<>:"|?*\x00-\x1f]|[ .]$/.test(name)
    && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:[ .]|$)/i.test(name);
}

function normalizeRelative(input: string): string {
  if (path.win32.isAbsolute(input) || input.split(/[\\/]/).some((part) => !validPathSegment(part))) {
    throw new Error('Invalid relative path');
  }
  const relative = path.posix.normalize(input.replaceAll('\\', '/')).replace(/\/$/, '');
  if (relative === '..' || relative.startsWith('../')) {
    throw new Error('Path is outside the project root');
  }
  return relative;
}

function isWithin(parent: string, target: string): boolean {
  // The native path implementation compares Windows paths case-insensitively.
  const relative = path.relative(parent, target);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function projectRelative(root: string, location: string): string {
  return path.relative(root, location).split(path.sep).join('/') || '.';
}

function assertAllowedPath(relativePath: string): void {
  if (sensitivePath(relativePath)) {
    throw new Error('Access to sensitive paths is denied');
  }
}

function errorCode(error: unknown): string | number | undefined {
  return (error as { code?: string | number }).code;
}

async function resolvePath(root: string, relativePath: string): Promise<string> {
  assertAllowedPath(relativePath);
  if (relativePath === '.') return root;

  let current = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    const candidate = path.join(current, part);
    try {
      current = await realpath(candidate);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;

      // A dangling link can report ENOENT from realpath while its entry still exists.
      try {
        await lstat(candidate);
      } catch (entryError) {
        if (errorCode(entryError) !== 'ENOENT') throw entryError;
        const target = path.join(current, ...parts.slice(index));
        assertAllowedPath(projectRelative(root, target));
        return target;
      }
      throw new Error('Path contains an unresolved link');
    }
    if (!isWithin(root, current)) throw new Error('Path points outside the project root');
    assertAllowedPath(projectRelative(root, current));
  }
  return current;
}

function integerAtLeast(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(name + ' must be an integer >= ' + minimum);
  }
}

function utf8Prefix(buffer: Buffer, maxBytes: number): string {
  let end = Math.min(buffer.length, maxBytes);
  if (end < buffer.length) {
    while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  }
  return buffer.toString('utf8', 0, end);
}

type WalkEntry = DirListResult['entries'][number] & { filename: string };

async function* walk(directory: string, relativePath: string, depth: number): AsyncGenerator<WalkEntry> {
  if (depth === 0) return;

  for await (const entry of await opendir(directory)) {
    // Avoid following links during traversal, including junctions and directory cycles.
    if (entry.isSymbolicLink() || !validPathSegment(entry.name)) continue;
    const relative = relativePath === '.' ? entry.name : relativePath + '/' + entry.name;
    if (sensitivePath(relative)) continue;

    const filename = path.join(directory, entry.name);
    const info = await lstat(filename);
    if (info.isDirectory()) {
      if (ignoredDirectories.has(entry.name.toLowerCase())) continue;
      yield { name: entry.name, relativePath: relative, kind: 'directory', sizeBytes: null, filename };
      yield* walk(filename, relative, depth - 1);
    } else if (info.isFile() && info.nlink === 1) {
      yield { name: entry.name, relativePath: relative, kind: 'file', sizeBytes: info.size, filename };
    }
  }
}

async function* textLines(filename: string, sizeBytes: number | undefined) {
  if (sizeBytes === undefined || sizeBytes > maxSearchFileBytes) return;
  const file = await open(filename, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxSearchFileBytes) return;
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ start: 0, end: maxSearchFileBytes, autoClose: false })) {
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks);
    if (content.length > maxSearchFileBytes || content.subarray(0, binaryProbeBytes).includes(0)) return;

    const lines = content.toString('utf8').split(/\r\n|\r|\n/);
    if (lines.at(-1) === '') lines.pop();
    yield* lines;
  } finally {
    await file.close();
  }
}

async function gitExecutable(root: string): Promise<string> {
  if (process.platform !== 'win32') return 'git';

  // Windows executable lookup can search the child working directory before PATH.
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    const directory = entry.replace(/^"|"$/g, '');
    if (!path.isAbsolute(directory) || isWithin(root, directory)) continue;
    const candidate = path.join(directory, 'git.exe');
    const info = await stat(candidate, { throwIfNoEntry: false });
    if (!info?.isFile()) continue;
    const executable = await realpath(candidate);
    if (!isWithin(root, executable)) return executable;
  }
  throw new Error('Git executable not found on PATH outside the project root');
}

const gitExclusions = [
  '.env*',
  ...sensitiveNames,
  ...sensitivePrefixes.map((prefix) => prefix + '*'),
  ...sensitiveExtensions.map((extension) => '*' + extension),
  ...gitSensitiveFiles.map((name) => '.git/' + name),
].flatMap((pattern) => [
  ':(exclude,icase,glob)**/' + pattern,
  ':(exclude,icase,glob)**/' + pattern + '/**',
]);

export class FileSandbox implements IFileSandbox {
  private readonly projects: Map<string, ProjectConfig>;

  constructor(projects: ProjectConfig[]) {
    this.projects = new Map(projects.map((project) => [project.id, { ...project }]));
  }

  listProjects(): ProjectSummary[] {
    return Array.from(this.projects.values(), (project) => ({ ...project }));
  }

  getProject(projectId: string): ProjectConfig {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Unknown project: ' + projectId);
    return { ...project };
  }

  upsertProject(project: ProjectConfig): ProjectSummary {
    const stored = { ...project };
    this.projects.set(stored.id, stored);
    return { ...stored };
  }

  removeProject(projectId: string): boolean {
    return this.projects.delete(projectId);
  }

  async resolveSafePath(projectId: string, relativePath = '.'): Promise<string> {
    const root = await realpath(this.getProject(projectId).rootPath);
    return resolvePath(root, normalizeRelative(relativePath));
  }

  async listDir(
    projectId: string,
    relativePath = '.',
    { maxDepth = 2, maxEntries = 200 } = {},
  ): Promise<DirListResult> {
    integerAtLeast(maxDepth, 0, 'maxDepth');
    integerAtLeast(maxEntries, 0, 'maxEntries');
    const root = await realpath(this.getProject(projectId).rootPath);
    const relative = normalizeRelative(relativePath);
    const directory = await resolvePath(root, relative);
    const result: DirListResult = { projectId, relativePath: relative, entries: [], truncated: false };
    if (skippedDirectory(relative) || skippedDirectory(projectRelative(root, directory))) return result;

    for await (const { filename: _filename, ...entry } of walk(directory, relative, maxDepth)) {
      if (result.entries.length === maxEntries) {
        result.truncated = true;
        break;
      }
      result.entries.push(entry);
    }
    return result;
  }

  async readLines(
    projectId: string,
    relativePath: string,
    startLine = 1,
    endLine = 200,
    { maxBytes = 32768 } = {},
  ): Promise<ReadLinesResult> {
    integerAtLeast(startLine, 1, 'startLine');
    integerAtLeast(endLine, startLine, 'endLine');
    integerAtLeast(maxBytes, 0, 'maxBytes');
    const relative = normalizeRelative(relativePath);
    const filename = await this.resolveSafePath(projectId, relative);
    const info = await stat(filename);
    if (!info.isFile() || info.nlink !== 1) throw new Error('A regular, unlinked file is required');

    const file = await open(filename, 'r');
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw new Error('A regular, unlinked file is required');
      const probe = Buffer.alloc(binaryProbeBytes);
      const { bytesRead } = await file.read(probe, 0, probe.length, 0);
      if (probe.subarray(0, bytesRead).includes(0)) throw new Error('Binary files cannot be read as text');

      const parts: string[] = [];
      let bytesLeft = maxBytes;
      let truncated = false;
      let totalLines = 0;
      let lineStarted = false;
      let previousCR = false;

      // Retain only the requested bytes while still counting every line.
      function consume(segment: string, endsLine: boolean) {
        const line = totalLines + 1;
        if (!truncated && line >= startLine && line <= endLine) {
          const text = !lineStarted && line > startLine ? '\n' + segment : segment;
          const buffer = Buffer.from(text);
          if (buffer.length > bytesLeft) {
            parts.push(utf8Prefix(buffer, bytesLeft));
            truncated = true;
          } else if (buffer.length > 0) {
            parts.push(text);
            bytesLeft -= buffer.length;
          }
        }
        lineStarted = !endsLine;
        if (endsLine) totalLines++;
      }

      const stream = file.createReadStream({ start: 0, autoClose: false }).setEncoding('utf8');
      for await (const rawChunk of stream as AsyncIterable<string>) {
        const chunk = previousCR && rawChunk.startsWith('\n') ? rawChunk.slice(1) : rawChunk;
        previousCR = rawChunk.endsWith('\r');
        let offset = 0;
        for (const separator of chunk.matchAll(/\r\n|\r|\n/g)) {
          consume(chunk.slice(offset, separator.index), true);
          offset = separator.index + separator[0].length;
        }
        if (offset < chunk.length) consume(chunk.slice(offset), false);
      }
      if (lineStarted) totalLines++;

      return {
        projectId,
        relativePath: relative,
        startLine,
        endLine: Math.min(endLine, totalLines),
        totalLines,
        content: parts.join(''),
        truncated,
      };
    } finally {
      await file.close();
    }
  }

  async searchFiles(
    projectId: string,
    query: string,
    { relativePath = '.', maxMatches = 50, caseSensitive = false } = {},
  ): Promise<SearchFilesResult> {
    if (!query.trim()) throw new Error('Search query must not be empty');
    integerAtLeast(maxMatches, 0, 'maxMatches');
    const root = await realpath(this.getProject(projectId).rootPath);
    const relative = normalizeRelative(relativePath);
    const target = await resolvePath(root, relative);
    const info = await stat(target);
    const result: SearchFilesResult = { projectId, query, matches: [], truncated: false };
    const logical = info.isDirectory() ? relative : path.posix.dirname(relative);
    const physical = projectRelative(root, info.isDirectory() ? target : path.dirname(target));
    if (skippedDirectory(logical) || skippedDirectory(physical)) return result;

    const needle = caseSensitive ? query : query.toLowerCase();
    async function* files() {
      if (info.isDirectory()) {
        for await (const entry of walk(target, relative, Infinity)) {
          if (entry.kind === 'file') yield entry;
        }
      } else if (info.isFile() && info.nlink === 1) {
        yield { relativePath: relative, filename: target, sizeBytes: info.size };
      }
    }

    for await (const entry of files()) {
      let line = 0;
      for await (const text of textLines(entry.filename, entry.sizeBytes ?? undefined)) {
        line++;
        if (!(caseSensitive ? text : text.toLowerCase()).includes(needle)) continue;
        if (result.matches.length === maxMatches) {
          result.truncated = true;
          return result;
        }
        result.matches.push({ relativePath: entry.relativePath, line, preview: text.slice(0, 240) });
      }
    }
    return result;
  }

  async gitStatusAndDiff(
    projectId: string,
    { maxDiffBytes = 49152, includeUntracked = true } = {},
  ): Promise<GitDiffResult> {
    integerAtLeast(maxDiffBytes, 0, 'maxDiffBytes');
    const cwd = await realpath(this.getProject(projectId).rootPath);
    const executable = await gitExecutable(cwd);
    const result: GitDiffResult = {
      projectId, isGitRepo: false, branch: null, statusPorcelain: '', diff: '', truncated: false,
    };
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^git_/i.test(key)));
    env.LC_ALL = 'C';
    const config = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false'];

    async function git(args: string[]) {
      return runGit(executable, [...config, ...args], {
        cwd,
        env,
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: Math.max(1024 * 1024, maxDiffBytes + 4),
      });
    }

    try {
      const { stdout } = await git(['rev-parse', '--is-inside-work-tree']);
      if (stdout.toString().trim() !== 'true') return result;
      const topLevel = await git(['rev-parse', '--show-toplevel']);
      const worktree = await realpath(topLevel.stdout.toString().replace(/\r?\n$/, ''));
      if (!isWithin(worktree, cwd)) throw new Error('Git worktree does not contain the project root');
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr;
      if (errorCode(error) === 128 && stderr?.toString().includes('not a git repository')) return result;
      throw error;
    }

    async function optionalGit(args: string[]) {
      try {
        return (await git(args)).stdout.toString().trim();
      } catch (error) {
        if (errorCode(error) === 1) return '';
        throw error;
      }
    }

    // Git's worktree comparisons can invoke configured clean/process filters.
    const filters = await optionalGit(['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$']);
    for (const key of filters.split('\0').filter(Boolean)) {
      config.push('-c', key + (key.endsWith('.required') ? '=false' : '='));
    }

    async function diff(args: string[]): Promise<Buffer> {
      try {
        return (await git([
          'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=all',
          '--relative', ...args, '--', '.', ...gitExclusions,
        ])).stdout;
      } catch (error) {
        const overflow = error as { stdout?: Buffer; message?: string };
        if (errorCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          && overflow.message?.startsWith('stdout') && overflow.stdout) {
          return overflow.stdout;
        }
        throw error;
      }
    }

    const [head, branch, status] = await Promise.all([
      optionalGit(['rev-parse', '--verify', '--quiet', 'HEAD']),
      optionalGit(['symbolic-ref', '--quiet', '--short', 'HEAD']),
      git([
        'status', '--porcelain', '--no-renames', '--ignore-submodules=all',
        includeUntracked ? '--untracked-files=all' : '--untracked-files=no', '--', '.', ...gitExclusions,
      ]),
    ]);

    const changes = head ? await diff(['HEAD']) : Buffer.concat([await diff(['--cached']), await diff([])]);
    // Git can emit non-UTF-8 file contents. Budget the bytes of the returned text.
    const textBytes = Buffer.from(changes.toString('utf8'));
    return {
      projectId,
      isGitRepo: true,
      branch: branch || (head ? 'HEAD' : null),
      statusPorcelain: status.stdout.toString(),
      diff: utf8Prefix(textBytes, maxDiffBytes),
      truncated: textBytes.length > maxDiffBytes,
    };
  }

  async writeDoc(
    projectId: string,
    relativePath: string,
    content: string,
    { overwrite = false } = {},
  ): Promise<WriteDocResult> {
    const project = this.getProject(projectId);
    if (project.permissionMode !== 'docs_write' && project.permissionMode !== 'codex_work') {
      throw new Error('Project permission mode does not allow writing documents');
    }

    const root = await realpath(project.rootPath);
    const relative = normalizeRelative(relativePath);
    const docs = path.resolve(root, normalizeRelative(project.docsSubdir));
    const logical = path.resolve(root, relative);
    function assertDoc(filename: string) {
      if (!isWithin(docs, filename) || path.relative(docs, filename) === '') {
        throw new Error('Document path must be inside docsSubdir');
      }
      if (!docExtensions.has(path.extname(filename).toLowerCase())) {
        throw new Error('Document file extension is not allowed');
      }
    }

    assertAllowedPath(relative);
    assertDoc(logical);
    const destination = await resolvePath(root, relative);
    assertDoc(destination);
    await mkdir(path.dirname(destination), { recursive: true });
    const target = await resolvePath(root, relative);
    assertDoc(target);

    if (!overwrite) {
      const verified = await resolvePath(root, relative);
      if (path.relative(target, verified) !== '') throw new Error('Document path changed during writing');
      let file;
      try {
        file = await open(target, 'wx');
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          throw new Error('Document already exists and overwrite is false');
        }
        throw error;
      }
      try {
        await file.writeFile(content, 'utf8');
      } finally {
        await file.close();
      }
      return { projectId, relativePath: relative, bytesWritten: Buffer.byteLength(content) };
    }

    const staged = path.join(path.dirname(target), '.file-sandbox-' + randomUUID() + '.tmp');
    const file = await open(staged, 'wx');
    try {
      try {
        await file.writeFile(content, 'utf8');
      } finally {
        await file.close();
      }

      const verified = await resolvePath(root, relative);
      if (path.relative(target, verified) !== '') throw new Error('Document path changed during writing');
      let existing: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        existing = await lstat(target);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      if (existing && (!existing.isFile() || existing.nlink !== 1)) {
        throw new Error('Only regular files without additional hard links can be overwritten');
      }
      await rename(staged, target);
    } finally {
      await rm(staged, { force: true });
    }
    return { projectId, relativePath: relative, bytesWritten: Buffer.byteLength(content) };
  }
}

export function createFileSandbox(projects: ProjectConfig[]): FileSandbox {
  return new FileSandbox(projects);
}
