import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';

function readUi() {
  return readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
}

test('monitor is a complete standalone HTML document with valid inline JavaScript', () => {
  const html = readUi();
  assert.match(html, /^\s*<!doctype html>\s*<html\b[^>]*>/i);
  assert.match(html, /<head\b[^>]*>[\s\S]*<\/head>/i);
  assert.match(html, /<body\b[^>]*>[\s\S]*<\/body>\s*<\/html>\s*$/i);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=|<link\b[^>]*\bhref\s*=/i);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length, 'the page must include its own script');
  for (const [, script] of scripts) {
    assert.doesNotThrow(() => new Script(script));
    assert.doesNotMatch(script, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
  }
});

test('monitor references the HTTP/SSE endpoints and mutation headers from the contract', () => {
  const html = readUi();
  for (const path of [
    '/api/health', '/api/projects', '/api/tasks', '/events', '/stream',
    '/interrupt', '/api/approvals/', '/decide',
  ]) {
    assert.ok(html.includes(path), `missing endpoint fragment ${path}`);
  }
  assert.match(html, /['"]X-Requested-With['"]\s*:\s*['"]ai-collab-hub-ui['"]/);
  assert.ok(html.includes('X-Hub-Token'));
  assert.match(html, /new EventSource\s*\(/);
});

test('monitor copies the server resume command and offers all four L2 decisions', () => {
  const html = readUi();
  assert.match(html, /codex resume/);
  assert.match(html, /clipboard\.writeText\s*\([^)]*resumeCommand/);
  for (const decision of ['accept', 'acceptForSession', 'decline', 'cancel']) {
    assert.match(html, new RegExp(`['"]${decision}['"]`));
  }
});
