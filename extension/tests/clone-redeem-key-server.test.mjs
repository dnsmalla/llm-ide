// End-to-end: a real `node server.mjs` serves the clone redeem only on an SSH server core. The key file is written and the
// redeem answers past the key check only when LLMIDE_SSH_SERVER=1 on a loopback, non-hub core. The local desktop core
// also sets LLMIDE_CORE_NONCE, and must get 404 and no key file. The /health nonce never redeems. Spawns the server,
// so it needs local listen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NONCE = 'c'.repeat(64);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/**
 * Stops the child and resolves once it has exited. The data dir must not be removed earlier: a live server may still be
 * writing SQLite WAL/shm files, which makes the delete fail intermittently with ENOTEMPTY.
 * @param {import('node:child_process').ChildProcess} child The spawned server.
 * @param {number} graceMs How long SIGTERM gets before SIGKILL, so a hung server cannot hang the suite.
 */
async function stopChild(child, graceMs = 5000) {
  if (child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
  await exited;
  clearTimeout(timer);
}

/**
 * Boots server.mjs with the given core identity.
 * @param {{ nonce?: string | null, sshServer?: boolean, hub?: boolean }} options The desktop nonce, the SSH server flag and
 *   hub mode.
 * @param {(ctx: object) => Promise<void>} fn Receives the data dir, port, /health answer and the output reader.
 */
async function withServer({ nonce = null, sshServer = false, hub = false }, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-clone-key-'));
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir,
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'),
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    LLMIDE_ENGINE_PREWARM: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.LLMIDE_CORE_NONCE;
  delete env.LLMIDE_SSH_SERVER;
  delete env.LLMIDE_HUB;
  if (nonce != null) env.LLMIDE_CORE_NONCE = nonce;
  if (sshServer) env.LLMIDE_SSH_SERVER = '1';
  if (hub) env.LLMIDE_HUB = '1';
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const deadline = Date.now() + 20_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode == null) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) { health = { headers: r.headers, body: await r.text() }; break; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(health, `server answered /health (output: ${output.slice(-2000)})`);
    await fn({ dir, port, health, output: () => output });
  } finally {
    await stopChild(child);
    // Retries cover a late WAL/shm write that lands while the directory is being removed.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function redeem(port, key, header = 'x-llmide-redeem-key') {
  return fetch(`http://127.0.0.1:${port}/internal/clone-credential`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [header]: key },
    body: JSON.stringify({ grant: 'e'.repeat(64) }),
  });
}

test('SSH server core (LLMIDE_SSH_SERVER=1, loopback): key file 0600, in no /health or log output, and the redeem is live', async () => {
  await withServer({ nonce: NONCE, sshServer: true }, async ({ dir, port, health, output }) => {
    const file = path.join(dir, 'clone-redeem.key');
    assert.equal(fs.existsSync(file), true, 'key file exists after start');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const key = fs.readFileSync(file, 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(health.body.includes(key), false);
    assert.equal(Object.values(Object.fromEntries(health.headers)).join(' ').includes(key), false);
    assert.equal(output().includes(key), false, 'the key is never logged');
    // The file key passes the key check: an unknown grant is then refused with the same 403, not a 404.
    const live = await redeem(port, key);
    assert.equal(live.status, 403);
    assert.deepEqual(await live.json(), { error: 'clone_credential_refused' });
    // The /health identity nonce is not the redeem key.
    const byNonce = await redeem(port, NONCE);
    assert.equal(byNonce.status, 403);
  });
});

test('desktop core (LLMIDE_CORE_NONCE set, LLMIDE_SSH_SERVER unset): no key file and the redeem answers 404', async () => {
  await withServer({ nonce: NONCE }, async ({ dir, port, output }) => {
    assert.equal(fs.existsSync(path.join(dir, 'clone-redeem.key')), false, 'a nonce alone writes no key');
    const r = await redeem(port, 'e'.repeat(64));
    assert.equal(r.status, 404);
    assert.equal(output().includes('e'.repeat(64)), false);
  });
});

test('hub core (LLMIDE_SSH_SERVER=1 with LLMIDE_HUB=1): no key file and the redeem answers 404', async () => {
  await withServer({ nonce: NONCE, sshServer: true, hub: true }, async ({ dir, port }) => {
    assert.equal(fs.existsSync(path.join(dir, 'clone-redeem.key')), false, 'a hub never writes the key');
    const r = await redeem(port, 'e'.repeat(64));
    assert.equal(r.status, 404);
  });
});
