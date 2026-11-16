// End-to-end: a real `node server.mjs` writes the clone redeem key file only in server mode (LLMIDE_CORE_NONCE set),
// and the /health identity nonce is never the redeem key. Spawns the server, so it needs local listen.
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

async function withServer({ nonce }, fn) {
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
  if (nonce == null) delete env.LLMIDE_CORE_NONCE; else env.LLMIDE_CORE_NONCE = nonce;
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
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('server mode: the redeem key file is written 0600 at start and is in no /health output or log', async () => {
  await withServer({ nonce: NONCE }, async ({ dir, port, health, output }) => {
    const file = path.join(dir, 'clone-redeem.key');
    assert.equal(fs.existsSync(file), true, 'key file exists after start');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const key = fs.readFileSync(file, 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(health.body.includes(key), false);
    assert.equal([...Object.values(Object.fromEntries(health.headers))].join(' ').includes(key), false);
    assert.equal(output().includes(key), false, 'the key is never logged');
    // The /health identity nonce is not the redeem key: a redeem with it is refused (403), not accepted.
    const r = await fetch(`http://127.0.0.1:${port}/internal/clone-credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llmide-redeem-key': NONCE },
      body: JSON.stringify({ grant: 'e'.repeat(64) }),
    });
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'clone_credential_refused' });
  });
});

test('no nonce: no key file is written and the redeem answers 404', async () => {
  await withServer({ nonce: null }, async ({ dir, port, output }) => {
    assert.equal(fs.existsSync(path.join(dir, 'clone-redeem.key')), false);
    const r = await fetch(`http://127.0.0.1:${port}/internal/clone-credential`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-llmide-redeem-key': 'e'.repeat(64) },
      body: JSON.stringify({ grant: 'e'.repeat(64) }),
    });
    assert.equal(r.status, 404);
    assert.equal(output().includes('e'.repeat(64)), false);
  });
});
