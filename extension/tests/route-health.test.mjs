// CLI health probe + routed-provider negative cache (providers/route-health.mjs).
// The probe is what makes a keyless OpenAI/Google tier "usable": a binary that
// merely exists on PATH (e.g. a codex npm shim whose native binary is missing)
// must not count. The negative cache is what a routed call's runtime failure
// writes so the next call — and the Settings status — skip that provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const {
  cliHealth, probeCli, awaitCliProbes, markRouteFailed, routeFailure,
  _setCliProbeRunnerForTests, _resetRouteHealthForTests,
} = await import('../providers/route-health.mjs');

function scriptCli(body) {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/probecli-`);
  const bin = `${dir}/fake-cli`;
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('cliHealth: never-probed → unverified, and it kicks the probe off in the background', async () => {
  _resetRouteHealthForTests();
  let calls = 0;
  _setCliProbeRunnerForTests(async () => { calls += 1; return true; });
  try {
    assert.equal(cliHealth('openai'), 'unverified');
    assert.equal(cliHealth('openai'), 'unverified', 'still in flight');
    await awaitCliProbes(['openai'], 1000);
    assert.equal(calls, 1, 'one probe per bin, deduplicated');
    assert.equal(cliHealth('openai'), 'ok');
  } finally { _setCliProbeRunnerForTests(null); _resetRouteHealthForTests(); }
});

test('cliHealth: success cached ~10 min, failure ~60 s, then re-probed', async () => {
  _resetRouteHealthForTests();
  let answer = false;
  let calls = 0;
  _setCliProbeRunnerForTests(async () => { calls += 1; return answer; });
  const t0 = 1_000_000;
  try {
    await probeCli('google', { now: t0 });
    assert.equal(cliHealth('google', { now: t0 + 30_000 }), 'failed');
    assert.equal(calls, 1);
    answer = true;
    assert.equal(cliHealth('google', { now: t0 + 61_000 }), 'failed', 'stale failure answers while re-probing');
    await awaitCliProbes(['google'], 1000);
    assert.equal(calls, 2);
    assert.equal(cliHealth('google', { now: t0 + 62_000 }), 'ok');
    assert.equal(cliHealth('google', { now: t0 + 62_000 + 9 * 60_000 }), 'ok');
    assert.equal(calls, 2, 'success still fresh at 9 min');
  } finally { _setCliProbeRunnerForTests(null); _resetRouteHealthForTests(); }
});

test('cliHealth: key-only providers and unknown providers are never probed', () => {
  _resetRouteHealthForTests();
  assert.equal(cliHealth('deepseek'), 'failed');
  assert.equal(cliHealth('custom'), 'failed');
  assert.equal(cliHealth('nope'), 'failed');
});

test('probeCli (real runner): `<bin> --version` exit 0 → ok; a broken shim (exit 1) → failed; a hang → failed', async () => {
  _resetRouteHealthForTests();
  const good = scriptCli('[ "$1" = "--version" ] && echo "codex 1.2.3" && exit 0; exit 3');
  const broken = scriptCli('echo "Error: spawn /opt/x/codex ENOENT" >&2; exit 1');
  const hang = scriptCli('sleep 10');
  try {
    process.env.LLMIDE_OPENAI_CLI = good.bin;
    assert.equal(await probeCli('openai'), true);
    _resetRouteHealthForTests();
    process.env.LLMIDE_OPENAI_CLI = broken.bin;
    assert.equal(await probeCli('openai'), false);
    _resetRouteHealthForTests();
    process.env.LLMIDE_OPENAI_CLI = 'definitely-not-a-real-binary-xyz';
    assert.equal(await probeCli('openai'), false);
    _resetRouteHealthForTests();
    process.env.LLMIDE_OPENAI_CLI = hang.bin;
    const t = Date.now();
    assert.equal(await probeCli('openai', { timeoutMs: 300 }), false);
    assert.ok(Date.now() - t < 3000);
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
    _resetRouteHealthForTests();
    good.cleanup(); broken.cleanup(); hang.cleanup();
  }
});

test('awaitCliProbes: bounded wait — a slow probe leaves the state unverified', async () => {
  _resetRouteHealthForTests();
  _setCliProbeRunnerForTests(() => new Promise((r) => setTimeout(() => r(true), 500)));
  try {
    cliHealth('openai');
    await awaitCliProbes(['openai'], 50);
    assert.equal(cliHealth('openai'), 'unverified');
  } finally { _setCliProbeRunnerForTests(null); _resetRouteHealthForTests(); }
});

test('markRouteFailed / routeFailure: per user + provider + MODEL, TTL chosen by the caller (default ~10 min)', () => {
  _resetRouteHealthForTests();
  const t0 = 5_000_000;
  assert.equal(routeFailure('u1', 'openai', 'gpt-5', { now: t0 }), null);
  markRouteFailed('u1', 'openai', 'gpt-5', 'cli', { now: t0 });
  assert.equal(routeFailure('u1', 'openai', 'gpt-5', { now: t0 + 1000 }), 'cli_failed');
  assert.equal(routeFailure('u1', 'openai', 'gpt-5-mini', { now: t0 + 1000 }), null,
    'one bad model id does not take the provider\'s other models offline');
  assert.equal(routeFailure('u2', 'openai', 'gpt-5', { now: t0 + 1000 }), null, 'other users unaffected');
  markRouteFailed('u1', 'custom:x', 'glm-4.6', 'key', { now: t0 });
  assert.equal(routeFailure('u1', 'custom:x', 'glm-4.6', { now: t0 + 1000 }), 'route_failed');
  assert.equal(routeFailure('u1', 'openai', 'gpt-5', { now: t0 + 11 * 60_000 }), null, 'expired');
  // A transient failure is remembered only briefly.
  markRouteFailed('u1', 'deepseek', 'deepseek-chat', 'key', { now: t0, ttlMs: 60_000 });
  assert.equal(routeFailure('u1', 'deepseek', 'deepseek-chat', { now: t0 + 30_000 }), 'route_failed');
  assert.equal(routeFailure('u1', 'deepseek', 'deepseek-chat', { now: t0 + 61_000 }), null);
  _resetRouteHealthForTests();
});

test('probeCli: a runner that never settles still resolves false and frees the in-flight slot', async () => {
  _resetRouteHealthForTests();
  let calls = 0;
  _setCliProbeRunnerForTests(() => { calls += 1; return new Promise(() => {}); });   // execFile callback never fires
  try {
    const t = Date.now();
    assert.equal(await probeCli('openai', { timeoutMs: 100 }), false);
    assert.ok(Date.now() - t < 3000);
    assert.equal(cliHealth('openai'), 'failed');
    await probeCli('openai', { timeoutMs: 100 });
    assert.equal(calls, 2, 'a new probe could start — the stuck one did not hold the slot');
  } finally { _setCliProbeRunnerForTests(null); _resetRouteHealthForTests(); }
});
