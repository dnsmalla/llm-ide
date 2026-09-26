// The Claude Agent SDK updater behind Settings → Backend
// (llm_agent/sdk/updater.mjs). npm and the post-install smoke check are
// faked: the contract under test is WHEN it installs, what it reports, and
// that a bad release is rolled back so the next restart still has an SDK.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { compareVersions, updateAllowed, updateSdk, fetchLatestVersion, __resetUpdaterForTest } =
  await import('../llm_agent/sdk/updater.mjs');

beforeEach(() => __resetUpdaterForTest());

function checkout(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-updater-'));
  setVersion(dir, version);
  return dir;
}
function setVersion(dir, version) {
  const pkgDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version }));
}
const registry = (latest) => async () => ({ ok: true, json: async () => ({ latest, next: latest }) });
const fakeInstall = (calls, { failFor } = {}) => async (version, dir) => {
  calls.push(version);
  if (version === failFor) return { ok: false, out: 'npm ERR! boom' };
  setVersion(dir, version);
  return { ok: true, out: `added ${version}` };
};

test('compareVersions orders x.y.z numerically, a prerelease before its release', () => {
  assert.ok(compareVersions('0.3.283', '0.3.272') > 0);
  assert.ok(compareVersions('0.3.99', '0.3.100') < 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0') < 0);
});

test('updates are refused while remote access is on, unless explicitly allowed', () => {
  assert.equal(updateAllowed({}).ok, true);
  assert.equal(updateAllowed({ LLMIDE_ALLOW_REMOTE: '1' }).ok, false);
  assert.equal(updateAllowed({ LLMIDE_ALLOW_REMOTE: '1', LLMIDE_ALLOW_SDK_UPDATE: '1' }).ok, true);
});

test('an update installs exactly the registry latest, smoke-checks it, and asks for a restart', async () => {
  const dir = checkout('0.3.272');
  const calls = [];
  const r = await updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: fakeInstall(calls), smokeFn: async () => ({ ok: true, out: '' }) });
  assert.deepEqual(calls, ['0.3.283']);
  assert.deepEqual([r.ok, r.from, r.to, r.restartNeeded, r.rolledBack], [true, '0.3.272', '0.3.283', true, false]);
});

test('a release that fails to load is rolled back to the previous version', async () => {
  const dir = checkout('0.3.272');
  const calls = [];
  const r = await updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: fakeInstall(calls), smokeFn: async () => ({ ok: false, out: 'missing exports: query' }) });
  assert.deepEqual(calls, ['0.3.283', '0.3.272'], 'installed, then restored');
  assert.deepEqual([r.ok, r.to, r.rolledBack, r.restartNeeded], [false, '0.3.272', true, false]);
  assert.match(r.log, /failed to load[\s\S]*Restored 0\.3\.272[\s\S]*missing exports/);
});

test('a failed npm install restores the previous version too', async () => {
  const dir = checkout('0.3.272');
  const calls = [];
  const r = await updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: fakeInstall(calls, { failFor: '0.3.283' }), smokeFn: async () => ({ ok: true }) });
  assert.deepEqual([r.ok, r.rolledBack, r.to], [false, true, '0.3.272']);
  assert.match(r.log, /npm install failed/);
});

test('already on the latest: nothing is installed', async () => {
  const dir = checkout('0.3.283');
  const calls = [];
  const r = await updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: fakeInstall(calls), smokeFn: async () => ({ ok: true }) });
  assert.deepEqual(calls, []);
  assert.deepEqual([r.ok, r.restartNeeded], [true, false]);
});

test('two clicks run one update', async () => {
  const dir = checkout('0.3.272');
  const calls = [];
  let release;
  const slow = async (v, d) => { await new Promise((r) => { release = r; }); return fakeInstall(calls)(v, d); };
  const a = updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: slow, smokeFn: async () => ({ ok: true }) });
  const b = updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: slow, smokeFn: async () => ({ ok: true }) });
  assert.equal(a, b, 'the same in-flight promise');
  while (!release) await new Promise((r) => setImmediate(r));
  release();
  await a;
  assert.deepEqual(calls, ['0.3.283']);
});

test('the registry answer must be a real version', async () => {
  await assert.rejects(fetchLatestVersion({ force: true, fetchFn: async () => ({ ok: true, json: async () => ({ latest: '1.0.0; rm -rf /' }) }) }), /no usable latest/);
  await assert.rejects(fetchLatestVersion({ force: true, fetchFn: async () => ({ ok: false, status: 503 }) }), /503/);
});

// Replacing the package under a running turn swaps its CLI mid-turn, and the
// restart after an update kills it — so an update waits for running turns,
// and turns are refused while an update runs.
test('an update refuses to start while chat turns are running, without blocking new turns', async () => {
  const { isSdkUpdating } = await import('../llm_agent/sdk/updater.mjs');
  const dir = checkout('0.3.272');
  const calls = [];
  const r = await updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: fakeInstall(calls), smokeFn: async () => ({ ok: true }), activeTurns: () => 2 });
  assert.deepEqual(calls, []);
  assert.equal(r.ok, false);
  assert.match(r.log, /2 chat turns are running/);
  assert.equal(isSdkUpdating(), false, 'a refusal leaves turns free to start');
});

test('isSdkUpdating is true for exactly the length of an update', async () => {
  const { isSdkUpdating } = await import('../llm_agent/sdk/updater.mjs');
  const dir = checkout('0.3.272');
  let release;
  const slow = async (v, d) => { await new Promise((r) => { release = r; }); return fakeInstall([])(v, d); };
  const p = updateSdk({ dir, fetchFn: registry('0.3.283'), installFn: slow, smokeFn: async () => ({ ok: true }) });
  assert.equal(isSdkUpdating(), true);
  while (!release) await new Promise((r) => setImmediate(r));
  release();
  await p;
  assert.equal(isSdkUpdating(), false);
});
