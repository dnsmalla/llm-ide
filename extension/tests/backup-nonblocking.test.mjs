// Backups run in a forked worker (kb/backup-worker.mjs): the snapshot is identical to the synchronous path, and a
// slow VACUUM no longer stalls the server's event loop. Spawns a real server for the stall check, so it needs local
// listen; the 50 MB fixture makes the difference measurable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('the forked worker writes a readable snapshot of data.db and agent.db', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-backup-worker-'));
  const dataDb = path.join(dir, 'data.db');
  const agentDb = path.join(dir, 'agent.db');
  const target = path.join(dir, 'backups', 'data-1.db');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const seed = (file, table) => {
    const db = new Database(file);
    db.exec(`CREATE TABLE ${table} (x TEXT); INSERT INTO ${table} VALUES ('kept');`);
    db.close();
  };
  seed(dataDb, 'notes');
  seed(agentDb, 'runs');
  // env is read for the default data path; the explicit paths below are what the worker uses.
  const { backupDatabasesInWorker } = await import('../kb/backup-databases.mjs');
  const made = await backupDatabasesInWorker(target, { dataDbPath: dataDb, agentDbPath: agentDb });
  assert.equal(made.path, target);
  assert.ok(made.bytes > 0);
  assert.equal(made.agentPath, path.join(dir, 'backups', 'data-1.agent.db'));
  assert.equal(new Database(target, { readonly: true }).prepare('SELECT x FROM notes').get().x, 'kept');
  assert.equal(new Database(made.agentPath, { readonly: true }).prepare('SELECT x FROM runs').get().x, 'kept');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 50 MB backup while /health still answers in under 200 ms', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-backup-live-'));
  const dbPath = path.join(dir, 'data.db');
  // ~50 MB of pages for VACUUM INTO to copy: the old synchronous path would hold the event loop for that long.
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE big (x BLOB);');
  const insert = seed.prepare('INSERT INTO big (x) VALUES (zeroblob(1000000))');
  seed.transaction(() => { for (let i = 0; i < 50; i += 1) insert.run(); })();
  seed.close();
  assert.ok(fs.statSync(dbPath).size > 45_000_000, 'the fixture is about 50 MB');

  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir, LLMIDE_DB_PATH: dbPath, LLMIDE_BACKUP_DIR: path.join(dir, 'backups'), LLMIDE_LOG_FILE: 'none',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
  };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode == null) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, `server answered /health (output: ${output.slice(-2000)})`);
    const post = (p, o, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(o) });
    assert.equal((await post('/auth/register', { email: 'backup@example.com', password: 'CorrectHorseBattery', displayName: 'B' })).status, 201);
    const login = await post('/auth/login', { email: 'backup@example.com', password: 'CorrectHorseBattery' });
    const { accessToken } = await login.json();
    const auth = { authorization: `Bearer ${accessToken}` };

    // A warm baseline, then the same request while the backup runs. The VACUUM happens in a child process, so the
    // second latency stays at the baseline; on the old synchronous path it waited for the whole copy.
    const baseStart = performance.now();
    await fetch(`${base}/health`);
    const baselineMs = performance.now() - baseStart;
    const backupPromise = post('/admin/backup', {}, auth);
    // Wait until the server has actually begun the copy (VACUUM creates the target file first), so the health probe
    // cannot win the race by being handled before the backup request.
    const backupDir = path.join(dir, 'backups');
    const began = Date.now() + 10_000;
    while (Date.now() < began) {
      let started = false;
      try { started = fs.readdirSync(backupDir).some((f) => /^data-\d+\.db$/.test(f)); } catch { /* not yet */ }
      if (started) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    const started = performance.now();
    const healthRes = await fetch(`${base}/health`);
    const healthMs = performance.now() - started;
    const backup = await backupPromise;
    const body = await backup.json();
    assert.equal(backup.status, 200, `backup answered 200 (body: ${JSON.stringify(body)})`);
    assert.ok(healthMs < 200, `/health answered in ${healthMs.toFixed(1)} ms while the backup ran`);
    assert.ok(healthMs < baselineMs + 50, `/health took ${healthMs.toFixed(1)} ms vs a ${baselineMs.toFixed(1)} ms baseline: the event loop was blocked`);
    const made = body.path;
    assert.ok(made && fs.existsSync(made), 'the snapshot exists');
    assert.ok(fs.statSync(made).size > 45_000_000, 'the snapshot is the whole 50 MB database');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
