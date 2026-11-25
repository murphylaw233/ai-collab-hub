import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { createFileSandbox } from '../src/sandbox/file-sandbox.js';
import type { ProjectConfig } from '../src/types.js';

function fixture(t: TestContext, overrides: Partial<ProjectConfig> = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), 'file-sandbox-测试-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));

  const root = path.join(temp, 'repo');
  const sibling = path.join(temp, 'repo-secret');
  mkdirSync(root);
  mkdirSync(sibling);
  const project: ProjectConfig = {
    id: 'test',
    name: 'Test project',
    rootPath: root,
    permissionMode: 'docs_write',
    docsSubdir: 'docs',
    ...overrides,
  };
  const sandbox = createFileSandbox([project]);

  function put(relativePath: string, content: string | Buffer) {
    const filename = path.join(root, relativePath);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
  }

  return { project, sandbox, root, sibling, put };
}

test('exposes only configured projects and copies permission metadata', (t) => {
  const { project, sandbox } = fixture(t);
  assert.deepEqual(sandbox.listProjects(), [project]);
  assert.deepEqual(sandbox.getProject(project.id), project);
  assert.throws(() => sandbox.getProject('unknown'), /unknown project/i);
  sandbox.getProject(project.id).permissionMode = 'read_only';
  assert.equal(sandbox.getProject(project.id).permissionMode, 'docs_write');
});

test('normalizes relative paths and rejects paths outside the project', async (t) => {
  const { root, sibling, sandbox, put } = fixture(t);
  put('docs/report.md', 'text');

  assert.equal(path.relative(realpathSync(root), await sandbox.resolveSafePath('test')), '');
  const requested = await sandbox.resolveSafePath('test', 'docs\\sub/../report.md');
  assert.equal(path.relative(realpathSync(path.join(root, 'docs/report.md')), requested), '');
  for (const relativePath of [
    '../outside.txt',
    '../repo-secret/outside.txt',
    path.join(sibling, 'outside.txt'),
    'C:\\Windows\\win.ini',
    '\\\\localhost\\c$',
    '\\rooted.txt',
    '/rooted.txt',
    'C:drive-relative.txt',
    'file.txt\0',
    'docs/report.md:stream',
    'docs/NUL.txt',
    'docs/report.md.',
  ]) {
    await assert.rejects(sandbox.resolveSafePath('test', relativePath), /path/i);
  }
});

test('blocks sensitive files and keeps only the two environment examples', async (t) => {
  const { sandbox, put } = fixture(t);
  const blocked = [
    '.env', '.Env.Local', '.environment', 'secret.key', 'cert.PEM', 'bundle.p12', 'bundle.pfx',
    'store.jks', 'auth.json', 'credentials.json', 'id_rsa', 'id_ed25519.pub', '.npmrc',
    '.pypirc', '.git/Config', '.git/credentials',
  ];
  for (const name of blocked) {
    put('docs/' + name, 'needle');
    await assert.rejects(sandbox.readLines('test', 'docs/' + name), /sensitive/i);
    await assert.rejects(sandbox.writeDoc('test', 'docs/' + name, 'changed'), /sensitive/i);
  }

  put('docs/.env.example', 'needle');
  put('docs/.env.sample', 'needle');
  const allowed = ['docs/.env.example', 'docs/.env.sample'];
  assert.deepEqual((await sandbox.listDir('test', 'docs')).entries.map((entry) => entry.relativePath).sort(), allowed);
  assert.deepEqual((await sandbox.searchFiles('test', 'needle')).matches.map((match) => match.relativePath).sort(), allowed);
  assert.equal((await sandbox.readLines('test', allowed[0])).content, 'needle');
});

test('blocks a symlink to an outside file and an alias for a sensitive file', async (t) => {
  const { root, sibling, sandbox, put } = fixture(t);
  const outside = path.join(sibling, 'outside.txt');
  writeFileSync(outside, 'outside');
  put('docs/.env', 'secret');
  try {
    symlinkSync(outside, path.join(root, 'docs/escape.txt'), 'file');
    symlinkSync(path.join(root, 'docs/.env'), path.join(root, 'docs/alias.txt'), 'file');
    symlinkSync(path.join(sibling, 'missing.txt'), path.join(root, 'docs/dangling.txt'), 'file');
  } catch (error) {
    // Windows may require Developer Mode or a privilege to create file symlinks.
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      return t.skip('File symlink creation requires Windows privileges');
    }
    throw error;
  }
  await assert.rejects(sandbox.readLines('test', 'docs/escape.txt'), /outside/i);
  await assert.rejects(sandbox.readLines('test', 'docs/alias.txt'), /sensitive/i);
  await assert.rejects(sandbox.writeDoc('test', 'docs/escape.txt', 'changed', { overwrite: true }), /outside/i);
  await assert.rejects(sandbox.writeDoc('test', 'docs/dangling.txt', 'changed', { overwrite: true }));
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
  assert.deepEqual((await sandbox.listDir('test', 'docs')).entries, []);
  assert.deepEqual((await sandbox.searchFiles('test', 'outside')).matches, []);
});

test('blocks junction escapes for missing descendants and for document writes', async (t) => {
  const { root, sibling, sandbox, put } = fixture(t);
  put('src/existing.md', 'source');
  mkdirSync(path.join(root, 'docs'));
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(sibling, path.join(root, 'docs/escape'), directoryLink);
    symlinkSync(path.join(root, 'src'), path.join(root, 'docs/source'), directoryLink);
  } catch (error) {
    // Restricted Windows processes may also be unable to create junctions.
    if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
      return t.skip('Directory junction creation is denied in this Windows process');
    }
    throw error;
  }
  await assert.rejects(sandbox.resolveSafePath('test', 'docs/escape/missing/future.md'), /outside/i);
  await assert.rejects(sandbox.writeDoc('test', 'docs/source/existing.md', 'changed', { overwrite: true }), /docs/i);
  assert.equal(readFileSync(path.join(root, 'src/existing.md'), 'utf8'), 'source');
});

test('lists project-relative paths with directory depth and entry limits', async (t) => {
  const { sandbox, put } = fixture(t);
  put('docs/leaf.txt', 'leaf');
  put('docs/folder/nested/file.txt', 'deep');
  for (const directory of ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']) {
    put('docs/' + directory + '/ignored.txt', 'ignored');
  }
  const listing = await sandbox.listDir('test', 'docs', { maxDepth: 1, maxEntries: 2 });
  assert.equal(listing.relativePath, 'docs');
  assert.equal(listing.truncated, false);
  assert.deepEqual(listing.entries.sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'folder', relativePath: 'docs/folder', kind: 'directory', sizeBytes: null },
    { name: 'leaf.txt', relativePath: 'docs/leaf.txt', kind: 'file', sizeBytes: 4 },
  ]);
  assert.equal((await sandbox.listDir('test', 'docs', { maxEntries: 1 })).truncated, true);
  assert.deepEqual((await sandbox.searchFiles('test', 'ignored')).matches, []);
});

test('reads one-based line ranges and truncates on UTF-8 boundaries', async (t) => {
  const { sandbox, put } = fixture(t);
  put('lines.txt', 'one\r\né中\r\nthree\n');
  put('binary.dat', Buffer.from([65, 0, 66]));

  assert.deepEqual(await sandbox.readLines('test', 'lines.txt', 2, 8), {
    projectId: 'test',
    relativePath: 'lines.txt',
    startLine: 2,
    endLine: 3,
    totalLines: 3,
    content: 'é中\nthree',
    truncated: false,
  });
  const clipped = await sandbox.readLines('test', 'lines.txt', 2, 3, { maxBytes: 4 });
  assert.equal(clipped.content, 'é');
  assert.equal(clipped.truncated, true);
  await assert.rejects(sandbox.readLines('test', 'binary.dat'), /binary/i);
  await assert.rejects(sandbox.readLines('test', 'lines.txt', 0), /line/i);
});

test('searches text lines with case and match limits', async (t) => {
  const { sandbox, put } = fixture(t);
  put('docs/results.txt', 'first\nNeedle\nneedle ' + 'x'.repeat(300));
  put('docs/binary.txt', 'needle\0');
  put('docs/large.txt', 'needle' + 'x'.repeat(1024 * 1024));

  const insensitive = await sandbox.searchFiles('test', 'needle', { relativePath: 'docs', maxMatches: 1 });
  assert.deepEqual(insensitive.matches, [{ relativePath: 'docs/results.txt', line: 2, preview: 'Needle' }]);
  assert.equal(insensitive.truncated, true);
  const exact = await sandbox.searchFiles('test', 'needle', { caseSensitive: true, maxMatches: 1 });
  assert.equal(exact.matches.length, 1);
  assert.equal(exact.matches[0].line, 3);
  assert.equal(exact.matches[0].preview.length, 240);
  assert.equal(exact.truncated, false);
  assert.equal((await sandbox.searchFiles('test', 'needle', { relativePath: 'docs/results.txt' })).matches.length, 2);
  await assert.rejects(sandbox.searchFiles('test', ''), /query/i);
});

test('writes UTF-8 documents only inside the docs directory and honors overwrite', async (t) => {
  const { root, project, sandbox } = fixture(t);
  const filename = 'docs/new/note.MD';
  assert.deepEqual(await sandbox.writeDoc('test', filename, '文档'), {
    projectId: 'test',
    relativePath: filename,
    bytesWritten: 6,
  });
  await assert.rejects(sandbox.writeDoc('test', filename, 'replace'), /exist/i);
  assert.equal(readFileSync(path.join(root, filename), 'utf8'), '文档');
  await sandbox.writeDoc('test', filename, 'replace', { overwrite: true });
  assert.equal(readFileSync(path.join(root, filename), 'utf8'), 'replace');
  for (const name of ['outside.md', 'docs-extra/note.md', 'docs/run.ts', 'docs/run.ps1']) {
    await assert.rejects(sandbox.writeDoc('test', name, 'text'), /docs|extension/i);
  }
  const readonly = createFileSandbox([{ ...project, permissionMode: 'read_only' }]);
  await assert.rejects(readonly.writeDoc('test', filename, 'text'), /permission|read.only/i);
  const codex = createFileSandbox([{ ...project, permissionMode: 'codex_work' }]);
  const results = await Promise.allSettled([
    codex.writeDoc('test', 'docs/concurrent.txt', 'first'),
    codex.writeDoc('test', 'docs/concurrent.txt', 'second'),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.deepEqual(readdirSync(path.join(root, 'docs')).sort(), ['concurrent.txt', 'new']);
});

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
}

test('returns an empty Git result for a non-repository', async (t) => {
  const { sandbox } = fixture(t);
  assert.deepEqual(await sandbox.gitStatusAndDiff('test'), {
    projectId: 'test',
    isGitRepo: false,
    branch: null,
    statusPorcelain: '',
    diff: '',
    truncated: false,
  });
});

test('returns Git branch, staged and unstaged diff, and optional untracked status', async (t) => {
  const { project, root, sandbox, put } = fixture(t);
  git(root, 'init', '--template=', '-b', 'sandbox-test');
  put('tracked.txt', 'base\n');
  put('.env', 'BASE_SECRET\n');
  git(root, 'add', '--', 'tracked.txt', '.env');

  const unborn = await sandbox.gitStatusAndDiff('test');
  assert.equal(unborn.branch, 'sandbox-test');
  assert.match(unborn.diff, /\+base/);
  assert.doesNotMatch(unborn.diff, /BASE_SECRET|\.env/);

  git(root, '-c', 'user.name=Sandbox Test', '-c', 'user.email=sandbox@example.test', 'commit', '-qm', 'Initial commit');
  put('tracked.txt', 'base\nstaged\n');
  git(root, 'add', '--', 'tracked.txt');
  put('tracked.txt', 'base\nstaged\nunstaged\n');
  put('.env', 'CHANGED_SECRET\n');
  put('docs/auth.json', 'UNTRACKED_SECRET\n');
  put('docs/untracked.txt', 'untracked\n');

  const result = await sandbox.gitStatusAndDiff('test');
  assert.equal(result.isGitRepo, true);
  assert.equal(result.branch, 'sandbox-test');
  assert.match(result.statusPorcelain, /MM tracked\.txt/);
  assert.match(result.statusPorcelain, /\?\? docs\/untracked\.txt/);
  assert.match(result.diff, /\+staged/);
  assert.match(result.diff, /\+unstaged/);
  assert.doesNotMatch(result.statusPorcelain + result.diff, /\.env|auth\.json|SECRET/);
  assert.equal(result.truncated, false);

  const scoped = createFileSandbox([{ ...project, rootPath: path.join(root, 'docs') }]);
  const nested = await scoped.gitStatusAndDiff('test');
  assert.match(nested.statusPorcelain, /\?\? docs\/untracked\.txt/);
  assert.doesNotMatch(nested.statusPorcelain + nested.diff, /(?:^|[ /])tracked\.txt|auth\.json/);

  const clipped = await sandbox.gitStatusAndDiff('test', { maxDiffBytes: 24, includeUntracked: false });
  assert.doesNotMatch(clipped.statusPorcelain, /untracked/);
  assert.equal(Buffer.byteLength(clipped.diff), 24);
  assert.equal(clipped.truncated, true);

  put('tracked.txt', Buffer.alloc(1_100_000, 0xff));
  const large = await sandbox.gitStatusAndDiff('test', { maxDiffBytes: 300 });
  assert.ok(Buffer.byteLength(large.diff) <= 300);
  assert.equal(large.truncated, true);
});
