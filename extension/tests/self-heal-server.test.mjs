// End-to-end: a real `node server.mjs` serves Self-Heal only with LLMIDE_SELF_HEAL=1. Off (the default and every
// release build): every path is 404 feature_disabled and /health does not advertise them. Spawns the server on a free
// loopback port, so it needs local listen permission (run the suite with the sandbox disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PATHS = [['GET', '/kb/self-heal/incidents'], ['POST', '/kb/self-heal/incidents'], ['DELETE', '/kb/self-heal/incidents'], ['POST', '/kb/self-heal/incidents/0123456789abcdef/ignore']];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function withServer(selfHeal, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-self-heal-'));
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_LOG_FILE: 'none',
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_ENV;
  delete env.LLMIDE_HOST_APPROVAL_KEY;
  if (selfHeal == null) delete env.LLMIDE_SELF_HEAL; else env.LLMIDE_SELF_HEAL = selfHeal;
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
    await fn(health, base);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function bearer(base) {
  const email = `shs-${Date.now()}@example.com`;
  const post = (p, o) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
  assert.equal((await post('/auth/register', { email, password: 'CorrectHorseBattery', displayName: 'S' })).status, 201);
  const { accessToken } = await (await post('/auth/login', { email, password: 'CorrectHorseBattery' })).json();
  return { authorization: `Bearer ${accessToken}` };
}

test('off by default: not advertised, every path 404 feature_disabled', async () => {
  await withServer(null, async (health, base) => {
    assert.ok(!health.endpoints.some((e) => e.startsWith('/kb/self-heal')));
    const auth = await bearer(base);
    for (const [m, p] of PATHS) {
      const r = await fetch(base + p, { method: m, headers: auth });
      assert.equal(r.status, 404, `${m} ${p}`);
      assert.deepEqual(await r.json(), { error: 'feature_disabled', feature: 'self_heal' });
    }
  });
});

test('LLMIDE_SELF_HEAL=1: advertised, and every route asks for the host proof first', async () => {
  await withServer('1', async (health, base) => {
    assert.ok(health.endpoints.includes('/kb/self-heal/incidents'));
    assert.ok(health.endpoints.includes('/kb/self-heal/incidents/:id/ignore'));
    const auth = await bearer(base);
    for (const [m, p] of PATHS) {
      const r = await fetch(base + p, { method: m, headers: auth });
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal((await r.json()).error.code, 'HOST_PROOF_REQUIRED');
    }
  });
});
