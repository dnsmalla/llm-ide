import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rateLimitProfile is module-private in server.mjs (importing it would boot
// the server), so lift its source and evaluate it standalone.
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs'), 'utf8');
const start = src.indexOf('function rateLimitProfile(');
const end = src.indexOf('\n}\n', start) + 2;
const rateLimitProfile = new Function(`${src.slice(start, end)}; return rateLimitProfile;`)();

test('POST profiles match with a query string appended', () => {
  for (const p of ['/kb/loop/agent-run', '/agent/v2/stream']) {
    assert.equal(rateLimitProfile(p, 'POST'), 'agentTurn', p);
    assert.equal(rateLimitProfile(`${p}?x=1`, 'POST'), 'agentTurn', `${p}?x=1`);
  }
  // /code-assist answers 410 (K1 P6 T6.9): never an agent turn
  assert.equal(rateLimitProfile('/code-assist?x=1', 'POST'), 'llmFast');
  assert.equal(rateLimitProfile('/kb/dispatch?a=b', 'POST'), 'dispatch');
  assert.equal(rateLimitProfile('/kb/export-all?x=1', 'GET'), 'kbExport');
  assert.equal(rateLimitProfile('/agent/v2/turns?x=1', 'GET'), 'kbWrite');
  assert.equal(rateLimitProfile('/kb/index/search?q=ab', 'GET'), 'kbWrite');
  assert.equal(rateLimitProfile('/kb/providers/custom', 'GET'), 'kbWrite');
  assert.equal(rateLimitProfile('/agent/v2/turns/stream?sessionId=a', 'GET'), 'kbWrite');
});

test('extension catalog steps that reach GitHub or the MCP registry ride the dispatch bucket; offline ones do not', () => {
  for (const p of ['install', 'catalog/refresh', 'updates/check', 'update/preview', 'update', 'repair']) {
    assert.equal(rateLimitProfile(`/auth/me/extensions/${p}`, 'POST'), 'dispatch', p);
  }
  for (const p of ['toggle', 'uninstall', 'rollback']) assert.notEqual(rateLimitProfile(`/auth/me/extensions/${p}`, 'POST'), 'dispatch', p);
});
