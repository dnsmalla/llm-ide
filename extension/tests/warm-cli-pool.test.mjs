import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const pool = await import('../providers/warm-cli-pool.mjs');

test('splitPromptArgs: only the trailing -p <prompt> form is split', () => {
  assert.deepEqual(pool.splitPromptArgs(['--tools', '', '-p', 'hello']), { base: ['--tools', ''], prompt: 'hello' });
  assert.equal(pool.splitPromptArgs(['-p', 'hello', '--tools', '']), null);
  assert.equal(pool.splitPromptArgs(['hello']), null);
  assert.equal(pool.splitPromptArgs([]), null);
});

test('warmArgs: stream-json flags replace --output-format json', () => {
  assert.deepEqual(pool.warmArgs(['--output-format', 'json', '--tools', '']),
    ['--tools', '', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
  assert.deepEqual(pool.warmArgs(['--tools', '']),
    ['--tools', '', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
});

test('poolKey: stable, 64 hex, and sensitive to every input', () => {
  const base = { bin: 'claude', base: ['--tools', ''], env: { PATH: '/x', HOME: '/h' }, cwd: '', userId: 'u1' };
  const k = pool.poolKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(pool.poolKey({ ...base, env: { HOME: '/h', PATH: '/x' } }), k, 'env order does not matter');
  assert.notEqual(pool.poolKey({ ...base, userId: 'u2' }), k);
  assert.notEqual(pool.poolKey({ ...base, cwd: '/p' }), k);
  assert.notEqual(pool.poolKey({ ...base, base: ['--tools', 'x'] }), k);
  assert.notEqual(pool.poolKey({ ...base, bin: '/opt/claude' }), k);
  assert.notEqual(pool.poolKey({ ...base, env: { PATH: '/x', HOME: '/h', ANTHROPIC_API_KEY: 'k' } }), k);
});

test('isWarmCliEnabled: off in tests unless opted in, off with LLMIDE_WARM_CLI=0', () => {
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'test' }), false);
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'test', LLMIDE_WARM_CLI: '1' }), true);
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'production' }), true);
  assert.equal(pool.isWarmCliEnabled({ NODE_ENV: 'production', LLMIDE_WARM_CLI: '0' }), false);
});

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-warm-claude.mjs');
// `node <fixture>` as the bin: spawn needs a real executable. process.execPath
// is node; the fixture path rides as the first base arg.
const spec = (extra = {}, userId = 'u1') => ({
  bin: process.execPath, base: [FAKE, '--output-format', 'json', '--tools', ''], env: { FAKE_WARM_MODE: 'ok', ...extra }, cwd: '', userId,
});
const pidReady = (file) => waitFor(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== '');
// An acquired child that is never run is owned by the caller, so the test must reap it.
const discard = (entry) => { entry.child.stdin.destroy(); entry.child.kill('SIGTERM'); };
const tick = () => new Promise((r) => setTimeout(r, 50));
const waitFor = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await tick(); } return false; };

process.env.LLMIDE_WARM_CLI = '1';   // opt the tests in (the module reads it per call)
// os.freemem() on macOS excludes reclaimable cache and can read < 1 GiB on a healthy
// machine; the floor is exercised explicitly in the limits test instead.
process.env.LLMIDE_WARM_CLI_MIN_FREE_BYTES = '0';

test('prewarm + acquire: second call reuses the idle child, returns stdout as the result JSON line', async () => {
  pool.flushWarmCliPool('test-start');
  assert.equal(pool.prewarm(spec()), true);
  assert.ok(await waitFor(() => pool._warmPoolStateForTests().idle === 1));
  const child = pool.acquireWarm(spec());
  assert.ok(child, 'idle child handed out');
  assert.equal(pool._warmPoolStateForTests().idle, 0, 'a child is used once');
  const out = await pool.runWarm(child, 'classify me', { timeoutMs: 5000, wantJson: true });
  assert.equal(out.bin, process.execPath);
  const obj = JSON.parse(out.stdout);
  assert.equal(obj.type, 'result');
  assert.match(obj.result, /classify me/);
  assert.equal(typeof out.stderr, 'string');
});

test('runWarm without wantJson returns the result text only', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm({ ...spec(), base: [FAKE, '--tools', ''] });
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm({ ...spec(), base: [FAKE, '--tools', ''] });
  const out = await pool.runWarm(child, 'hi', { timeoutMs: 5000, wantJson: false });
  assert.match(out.stdout, /^\{"mode":"execute"/);
});

test('acquire: a different userId / cwd / env / base never gets the idle child', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec());
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  assert.equal(pool.acquireWarm(spec({}, 'u2')), null);
  assert.equal(pool.acquireWarm({ ...spec(), cwd: '/tmp' }), null);
  assert.equal(pool.acquireWarm(spec({ EXTRA: '1' })), null);
  assert.equal(pool.acquireWarm({ ...spec(), base: [FAKE, '--tools', 'x'] }), null);
  const mine = pool.acquireWarm(spec());
  assert.ok(mine, 'the exact key still gets it');
  discard(mine);
});

test('concurrent acquire hands out one child once', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec());
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const a = pool.acquireWarm(spec());
  const b = pool.acquireWarm(spec());
  assert.ok(a);
  assert.equal(b, null);
  await pool.runWarm(a, 'x', { timeoutMs: 5000, wantJson: true });
});

test('is_error maps to exit code 1 with stdout/stderr attached', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec({ FAKE_WARM_MODE: 'is_error' }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm(spec({ FAKE_WARM_MODE: 'is_error' }));
  await assert.rejects(pool.runWarm(child, 'x', { timeoutMs: 5000, wantJson: true }), (err) => {
    assert.equal(err.code, 1);
    assert.equal(err.killed, false);
    assert.equal(err.bin, process.execPath);
    assert.match(err.stdout, /Not logged in/);
    assert.equal(pool.isWarmRetryable(err), true, 'auth-shaped → cold retry');
    return true;
  });
});

test('exited before use → acquire returns null (dropped silently)', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec({ FAKE_WARM_MODE: 'exit_before_read' }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 0, 3000);
  assert.equal(pool.acquireWarm(spec({ FAKE_WARM_MODE: 'exit_before_read' })), null);
});

test('exited after the prompt without a result → execFile-shaped error, retryable', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec({ FAKE_WARM_MODE: 'exit_after_read' }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm(spec({ FAKE_WARM_MODE: 'exit_after_read' }));
  await assert.rejects(pool.runWarm(child, 'x', { timeoutMs: 5000, wantJson: true }), (err) => {
    assert.equal(err.code, 2);
    assert.equal(err.killed, false);
    assert.equal(pool.isWarmRetryable(err), true, 'no answer at all → cold retry');
    return true;
  });
});

test('timeout kills the child and reports killed:true; not retryable', async () => {
  pool.flushWarmCliPool('t');
  const pidFile = path.join(os.tmpdir(), `warm-pid-${process.pid}-${Date.now()}`);
  pool.prewarm(spec({ FAKE_WARM_MODE: 'hang', FAKE_WARM_PID_FILE: pidFile }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm(spec({ FAKE_WARM_MODE: 'hang', FAKE_WARM_PID_FILE: pidFile }));
  await assert.rejects(pool.runWarm(child, 'x', { timeoutMs: 200, wantJson: true }), (err) => {
    assert.equal(err.killed, true);
    assert.equal(err.signal, 'SIGTERM');
    assert.equal(pool.isWarmRetryable(err), false);
    return true;
  });
  assert.ok(await pidReady(pidFile), 'fixture wrote its pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'child is gone');
});

test('abort kills the child and rejects with AbortError', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec({ FAKE_WARM_MODE: 'hang' }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm(spec({ FAKE_WARM_MODE: 'hang' }));
  const ac = new AbortController();
  const p = pool.runWarm(child, 'x', { timeoutMs: 5000, signal: ac.signal, wantJson: true });
  ac.abort();
  await assert.rejects(p, (err) => { assert.equal(err.name, 'AbortError'); assert.equal(pool.isWarmRetryable(err), false); return true; });
});

test('output over maxBuffer kills the child with ERR_CHILD_PROCESS_STDIO_MAXBUFFER', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec({ FAKE_WARM_MODE: 'big' }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm(spec({ FAKE_WARM_MODE: 'big' }));
  await assert.rejects(pool.runWarm(child, 'x', { timeoutMs: 5000, wantJson: true }), (err) => {
    assert.equal(err.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    return true;
  });
});

test('limits: max 1 idle (LRU evicted), 2-min idle kill with a fake clock, no spawn when memory is low', async () => {
  pool.flushWarmCliPool('t');
  let now = 1_000_000;
  const clock = { now: () => now };
  assert.equal(pool.prewarm(spec({}, 'a'), clock), true);
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  assert.equal(pool.prewarm(spec({}, 'b'), clock), true, 'second key evicts the first (max 1)');
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  assert.equal(pool.acquireWarm(spec({}, 'a')), null, 'a was evicted');
  const survivor = pool.acquireWarm(spec({}, 'b'));
  assert.ok(survivor, 'b is the survivor');
  discard(survivor);
  pool.flushWarmCliPool('t');
  pool.prewarm(spec(), { ...clock, freemem: () => -1 });
  assert.equal(pool._warmPoolStateForTests().spawning, false, 'low memory → no spawn');
  assert.equal(pool._warmPoolStateForTests().idle, 0);
  pool.prewarm(spec(), clock);
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  now += 120_001;
  pool._sweepIdleForTests(clock);
  assert.ok(await waitFor(() => pool._warmPoolStateForTests().idle === 0), 'idle child killed after 2 min');
});

test('flushWarmCliPool kills every idle child (pid gone)', async () => {
  pool.flushWarmCliPool('t');
  const pidFile = path.join(os.tmpdir(), `warm-pid-${process.pid}-${Date.now()}-f`);
  pool.prewarm(spec({ FAKE_WARM_PID_FILE: pidFile }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  assert.ok(await pidReady(pidFile), 'fixture wrote its pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  pool.flushWarmCliPool('test');
  assert.equal(pool._warmPoolStateForTests().idle, 0);
  assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'child is gone');
});

test('child exits when the parent closes stdin (no orphan on SIGKILL)', async () => {
  pool.flushWarmCliPool('t');
  const pidFile = path.join(os.tmpdir(), `warm-pid-${process.pid}-${Date.now()}-o`);
  pool.prewarm(spec({ FAKE_WARM_MODE: 'hang', FAKE_WARM_PID_FILE: pidFile }));
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const child = pool.acquireWarm(spec({ FAKE_WARM_MODE: 'hang', FAKE_WARM_PID_FILE: pidFile }));
  child.child.stdin.end();          // what the OS does to the pipe when the parent dies
  assert.ok(await pidReady(pidFile), 'fixture wrote its pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 3000), 'EOF on stdin ends the child');
});

test('rememberBinStamp flushes when the binary identity changes', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec());
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  assert.equal(pool.rememberBinStamp('/a/claude', 1), false);
  assert.equal(pool.rememberBinStamp('/a/claude', 1), false);
  assert.equal(pool._warmPoolStateForTests().idle, 1);
  assert.equal(pool.rememberBinStamp('/a/claude', 2), true);
  assert.equal(pool._warmPoolStateForTests().idle, 0);
});

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                3618.
Pages inactive:                          205707.
Pages speculative:                         9203.
Pages purgeable:                              .
`;

test('availableMemoryBytes: darwin sums free+inactive+speculative+purgeable pages', () => {
  pool._resetMemCacheForTests();
  const got = pool.availableMemoryBytes({ platform: 'darwin', runVmStat: () => VM_STAT, now: () => 1 });
  assert.equal(got, (3618 + 205707 + 9203 + 0) * 16384);
});

test('availableMemoryBytes: non-darwin and a failing vm_stat fall back to os.freemem()', () => {
  pool._resetMemCacheForTests();
  const near = (v) => Math.abs(v - os.freemem()) < 512 * 1024 * 1024;
  assert.ok(near(pool.availableMemoryBytes({ platform: 'linux', runVmStat: () => VM_STAT })));
  assert.ok(near(pool.availableMemoryBytes({ platform: 'darwin', runVmStat: () => { throw new Error('boom'); } })));
  assert.ok(near(pool.availableMemoryBytes({ platform: 'darwin', runVmStat: () => 'garbage' })));
});

test('availableMemoryBytes: cached for 30 s', () => {
  pool._resetMemCacheForTests();
  let calls = 0;
  const run = () => { calls++; return VM_STAT; };
  pool.availableMemoryBytes({ platform: 'darwin', runVmStat: run, now: () => 1000 });
  pool.availableMemoryBytes({ platform: 'darwin', runVmStat: run, now: () => 29_000 });
  assert.equal(calls, 1);
  pool.availableMemoryBytes({ platform: 'darwin', runVmStat: run, now: () => 31_001 });
  assert.equal(calls, 2);
});

test('an acquired child finishing does not unseat a newer idle child with the same key', async () => {
  pool.flushWarmCliPool('t');
  pool.prewarm(spec());
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  const first = pool.acquireWarm(spec());
  assert.equal(pool.prewarm(spec()), true, 'same key prewarmed again');
  assert.equal(pool._warmPoolStateForTests().idle, 1);
  await pool.runWarm(first, 'x', { timeoutMs: 5000, wantJson: true });
  assert.ok(await waitFor(() => first.exited !== null), 'first child exited');
  assert.equal(pool._warmPoolStateForTests().idle, 1, 'newer entry still tracked');
  pool.flushWarmCliPool('t');
});

test('an idle child that floods stderr past the cap is killed and removed', async () => {
  pool.flushWarmCliPool('t');
  const pidFile = path.join(os.tmpdir(), `warm-pid-${process.pid}-${Date.now()}-fl`);
  pool.prewarm(spec({ FAKE_WARM_MODE: 'flood_idle', FAKE_WARM_PID_FILE: pidFile }));
  assert.ok(await pidReady(pidFile));
  assert.ok(await waitFor(() => pool._warmPoolStateForTests().idle === 0), 'removed from the pool');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'child is gone');
});

const { spawnCli } = await import('../providers/providers.mjs');

test('spawnCli: warm:true uses the pool only for the default claude bin', async () => {
  pool.flushWarmCliPool('t');
  // An override is set in this test process (the fake) → pool must NOT be used,
  // even with warm:true. Proven by: no idle child appears after the call.
  process.env.LLMIDE_ANTHROPIC_CLI = process.execPath;
  const out = await spawnCli('anthropic', 'hello', {
    warm: true, userId: 'u1', env: { FAKE_WARM_MODE: 'ok', PATH: process.env.PATH },
    args: [FAKE, '--output-format', 'json', '--tools', '', '-p', 'hello'], timeoutMs: 5000,
  });
  assert.match(out.stdout, /"type":"result"/);
  await tick();
  assert.equal(pool._warmPoolStateForTests().idle, 0, 'override bin → never pre-warmed');
  delete process.env.LLMIDE_ANTHROPIC_CLI;
});

test('spawnCli: warm path falls back cold once on a retryable warm failure, and prewarms after', async () => {
  pool.flushWarmCliPool('t');
  const calls = [];
  const s = { bin: process.execPath, base: [FAKE, '--output-format', 'json', '--tools', ''], env: { FAKE_WARM_MODE: 'exit_after_read', PATH: process.env.PATH }, cwd: '', userId: 'u9' };
  pool.prewarm(s);
  await waitFor(() => pool._warmPoolStateForTests().idle === 1);
  // Drive spawnCli's warm branch directly through its test seam.
  const out = await pool._spawnWithWarmForTests({
    bin: s.bin, args: [...s.base, '-p', 'hello'], env: { ...s.env, FAKE_WARM_MODE: 'ok' }, cwd: '', userId: 'u9', timeoutMs: 5000,
    cold: async () => { calls.push('cold'); return { stdout: '{"type":"result","result":"cold","is_error":false}', stderr: '', bin: s.bin }; },
  });
  assert.deepEqual(calls, ['cold'], 'one cold retry after the warm child died');
  assert.match(out.stdout, /cold/);
});

test('cleanup: leave no idle child behind', () => {
  pool.flushWarmCliPool('t');
  assert.equal(pool._warmPoolStateForTests().idle, 0);
});
