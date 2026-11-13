import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { parentAlive, parentPidFrom, watchParent } from '../core/parent-watch.mjs';

test('the host pid is read only from a well-formed LLMIDE_PARENT_PID', () => {
  assert.equal(parentPidFrom({ LLMIDE_PARENT_PID: '4242' }), 4242);
  assert.equal(parentPidFrom({}), null, 'a core started by hand is never watched');
  for (const bad of ['', '0', '-1', '12abc', ' 12', '1e3', '99999999999']) assert.equal(parentPidFrom({ LLMIDE_PARENT_PID: bad }), null, bad);
});

test('parentAlive: gone on ESRCH, alive on EPERM, and a changed ppid means gone even if the pid was reused', () => {
  const esrch = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  const eperm = () => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); };
  const ok = () => true;
  assert.equal(parentAlive(10, { kill: ok, ppid: () => 10, platform: 'darwin' }), true);
  assert.equal(parentAlive(10, { kill: esrch, ppid: () => 10, platform: 'darwin' }), false);
  assert.equal(parentAlive(10, { kill: eperm, ppid: () => 10, platform: 'linux' }), true);
  assert.equal(parentAlive(10, { kill: ok, ppid: () => 1, platform: 'darwin' }), false, 're-parented: the host is gone');
  // Windows does not re-parent, so only the existence check counts there.
  assert.equal(parentAlive(10, { kill: ok, ppid: () => 999, platform: 'win32' }), true);
  assert.equal(parentAlive(10, { kill: esrch, ppid: () => 999, platform: 'win32' }), false);
});

test('watchParent calls onGone once, stops polling after it, and does nothing without a pid', () => {
  let tick = null;
  let cleared = 0;
  const timers = { setTimer: (fn) => { tick = fn; return { unref() {} }; }, clearTimer: () => { cleared += 1; } };
  let alive = true;
  let gone = 0;
  watchParent({ pid: 10, onGone: () => { gone += 1; }, alive: () => alive, ...timers });
  tick(); tick();
  assert.equal(gone, 0);
  alive = false;
  tick(); tick();
  assert.equal(gone, 1, 'reported once');
  assert.equal(cleared, 1);

  let armed = false;
  const stop = watchParent({ pid: null, onGone: () => { gone += 1; }, setTimer: () => { armed = true; }, clearTimer() {} });
  assert.equal(armed, false);
  stop();
});

test('a real child notices its parent dying and exits by itself', { skip: process.platform === 'win32' }, async () => {
  // parent (sh) starts a node child that watches it, prints the child's pid, then the parent is killed.
  const child = `import('${new URL('../core/parent-watch.mjs', import.meta.url).href}').then(({ watchParent, parentPidFrom }) => {
    console.log(process.pid);
    watchParent({ pid: parentPidFrom(), intervalMs: 50, onGone: () => process.exit(0) });
    setInterval(() => {}, 1000);
  });`;
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(child)}], { env: { ...process.env, LLMIDE_PARENT_PID: String(process.pid) }, stdio: ['ignore', 'inherit', 'inherit'] });
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const pid = await new Promise((resolve, reject) => {
    let buf = '';
    parent.stdout.on('data', (d) => { buf += d; const m = /^(\d+)\s/.exec(buf); if (m) resolve(Number(m[1])); });
    parent.on('exit', () => reject(new Error('parent exited before the child reported')));
  });
  const isAlive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.equal(isAlive(), true);
  parent.kill('SIGKILL'); // a force quit: the parent gets no chance to stop its child
  const deadline = Date.now() + 5000;
  while (isAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const survived = isAlive();
  if (survived) process.kill(pid, 'SIGKILL');
  assert.equal(survived, false, 'the orphan exited once its parent was gone');
});

// The real core, booted in an isolated data folder under a throwaway parent. Needs local listen.
test('the core shuts itself down after its host is force-quit, and frees the port', { skip: process.platform === 'win32' }, async () => {
  const fs = await import('node:fs');
  const net = await import('node:net');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-parent-watch-'));
  const port = await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir, LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_LOG_FILE: 'none',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
    LLMIDE_JWT_SECRET: 'j'.repeat(48), LLMIDE_VAULT_KEY: 'v'.repeat(48),
  };
  delete env.NODE_TEST_CONTEXT;
  // The stand-in host: spawns the core exactly as the desktop does (its own pid in LLMIDE_PARENT_PID), then idles.
  const host = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['server.mjs'], { cwd: ${JSON.stringify(EXT)}, env: { ...process.env, LLMIDE_PARENT_PID: String(process.pid) }, stdio: 'ignore' });
    console.log(c.pid);
    setInterval(() => {}, 1000);
  `], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const corePid = await new Promise((resolve, reject) => {
    let buf = '';
    host.stdout.on('data', (d) => { buf += d; const m = /^(\d+)\s/.exec(buf); if (m) resolve(Number(m[1])); });
    host.on('exit', () => reject(new Error('the stand-in host exited early')));
  });
  const alive = () => { try { process.kill(corePid, 0); return true; } catch { return false; } };
  const healthy = async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } };
  try {
    let up = false;
    for (const end = Date.now() + 20_000; Date.now() < end && alive();) {
      if (await healthy()) { up = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(up, 'the core answered /health under its host');
    // While the host lives, the watch leaves the core alone (two polls of 2 s).
    await new Promise((r) => setTimeout(r, 4500));
    assert.equal(await healthy(), true, 'a live host never stops its core');

    host.kill('SIGKILL'); // force quit: no shutdown hook runs in the host
    for (const end = Date.now() + 20_000; Date.now() < end && alive();) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(), false, 'the orphaned core exited by itself');
    assert.equal(await healthy(), false, 'and no longer holds the port');
  } finally {
    if (alive()) process.kill(corePid, 'SIGKILL');
    host.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
