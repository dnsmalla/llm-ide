// importWithTrustCheck: every import path resets hook trust + MCP consents
// when the copy's executables change, and fails closed when hashing fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWithTrustCheck, beginTrustCheck, finishTrustCheck } from '../plugins/import-trust.mjs';

const root = mkdtempSync(join(tmpdir(), 'import-trust-'));
let n = 0;

function pluginDir({ hooks } = {}) {
  n += 1;
  const dir = join(root, `p${n}`, 'claude-demo');
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, 'hooks', 'hooks.json'), hooks ?? '{"hooks":{}}', 'utf8');
  return dir;
}

function spies() {
  const calls = { trust: [], mcp: [] };
  return { calls, clearTrust: (x) => calls.trust.push(x), clearMcpConsents: (x) => calls.mcp.push(x) };
}

const writeHooks = (dir, body) => () => { writeFileSync(join(dir, 'hooks', 'hooks.json'), body, 'utf8'); return { ok: true }; };

test('unchanged executables keep trust', () => {
  const dir = pluginDir();
  const s = spies();
  const res = importWithTrustCheck({ dir, doImport: writeHooks(dir, '{"hooks":{}}'), ...s });
  assert.equal(res.ok, true);
  assert.equal(res.trustReset, false);
  assert.deepEqual(s.calls, { trust: [], mcp: [] });
});

test('changed executables reset hook trust and MCP consents by plugin name', () => {
  const dir = pluginDir();
  const s = spies();
  const res = importWithTrustCheck({ dir, doImport: writeHooks(dir, '{"hooks":{"Stop":[]}}'), ...s });
  assert.equal(res.trustReset, true);
  assert.deepEqual(s.calls, { trust: ['claude-demo'], mcp: ['claude-demo'] });
});

test('a first import (no previous copy) resets stale grants', () => {
  const dir = join(root, 'fresh', 'claude-demo');
  const s = spies();
  const res = importWithTrustCheck({
    dir, doImport: () => { mkdirSync(dir, { recursive: true }); return { ok: true }; }, ...s,
  });
  assert.equal(res.trustReset, true);
  assert.deepEqual(s.calls.trust, ['claude-demo']);
});

test('a failed import resets nothing and passes the failure through', () => {
  const dir = pluginDir();
  const s = spies();
  const res = importWithTrustCheck({ dir, doImport: () => ({ ok: false, error: 'nope' }), ...s });
  assert.deepEqual(res, { ok: false, error: 'nope', trustReset: false });
  assert.deepEqual(s.calls, { trust: [], mcp: [] });
});

test('hash failure fails closed (trust reset)', () => {
  for (const throwOn of [1, 2]) {
    const dir = pluginDir();
    const s = spies();
    let calls = 0;
    const hash = () => { calls += 1; if (calls === throwOn) throw new Error('EACCES'); return 'same'; };
    const res = importWithTrustCheck({ dir, doImport: () => ({ ok: true }), hash, ...s });
    assert.equal(res.trustReset, true, `throw on hash #${throwOn}`);
    assert.deepEqual(s.calls, { trust: ['claude-demo'], mcp: ['claude-demo'] });
  }
});

test('begin/finish match importWithTrustCheck', () => {
  const run = (setup, ok = true) => {
    const dir = setup.dir;
    const s = spies();
    const token = beginTrustCheck(dir, setup.opts);
    if (ok) writeHooks(dir, setup.after)();
    const reset = finishTrustCheck(token, { ok, ...s });
    return { reset, calls: s.calls };
  };
  const changed = run({ dir: pluginDir(), after: '{"x":1}' });
  assert.equal(changed.reset, true);
  assert.deepEqual(changed.calls, { trust: ['claude-demo'], mcp: ['claude-demo'] });
  assert.equal(run({ dir: pluginDir(), after: '{"hooks":{}}' }).reset, false);
  const fresh = join(root, 'fresh', 'claude-demo');
  mkdirSync(join(fresh, 'hooks'), { recursive: true });
  assert.equal(finishTrustCheck(beginTrustCheck(join(root, 'nope', 'claude-demo')), { ok: true, ...spies() }), true);
  const boom = () => { throw new Error('x'); };
  assert.equal(run({ dir: pluginDir(), after: '{"hooks":{}}', opts: { hash: boom } }).reset, true);
  const failed = run({ dir: pluginDir(), after: 'zzz' }, false);
  assert.equal(failed.reset, false);
  assert.deepEqual(failed.calls, { trust: [], mcp: [] });
});
