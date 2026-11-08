// Hub boot guard (REQ-014 B1): a hub bound to a non-loopback address refuses to start unless the operator
// declares the TLS terminator in front of it. Spawns real `node server.mjs`, so it needs local listen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '0.0.0.0', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function boot(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-hub-tls-'));
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '0.0.0.0',
    LLMIDE_HUB: '1', LLMIDE_ALLOW_REMOTE: '1',
    LLMIDE_DATA_DIR: dir, LLMIDE_DB_PATH: path.join(dir, 'kb.db'),
    LLMIDE_LOG_FILE: 'none',
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
    ...extra,
  };
  delete env.LLMIDE_TLS_TERMINATED;
  if (extra.LLMIDE_TLS_TERMINATED !== undefined) env.LLMIDE_TLS_TERMINATED = extra.LLMIDE_TLS_TERMINATED;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_ENV;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const cleanup = () => { try { child.kill('SIGTERM'); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); };
  return { child, port, output: () => output, exited, cleanup };
}

test('hub on 0.0.0.0 without LLMIDE_TLS_TERMINATED=1 exits 1 with hub_requires_tls', async () => {
  const b = await boot({});
  try {
    const code = await Promise.race([b.exited, new Promise((r) => setTimeout(() => r('timeout'), 20_000))]);
    assert.equal(code, 1, `server exited 1 (output: ${b.output().slice(-2000)})`);
    assert.match(b.output(), /hub_requires_tls/);
    assert.match(b.output(), /LLMIDE_TLS_TERMINATED/);
  } finally { b.cleanup(); }
});

test('hub on 0.0.0.0 with LLMIDE_TLS_TERMINATED=1 boots and serves /health', async () => {
  const b = await boot({ LLMIDE_TLS_TERMINATED: '1' });
  try {
    const base = `http://127.0.0.1:${b.port}`;
    const deadline = Date.now() + 20_000;
    let health = null;
    while (Date.now() < deadline && b.child.exitCode == null) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, `server answered /health (output: ${b.output().slice(-2000)})`);
    assert.equal(health.features !== undefined, true);
  } finally { b.cleanup(); }
});

test('a loopback hub needs no TLS declaration', async () => {
  const b = await boot({ LLMIDE_HOST: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${b.port}`;
    const deadline = Date.now() + 20_000;
    let health = null;
    while (Date.now() < deadline && b.child.exitCode == null) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, `loopback hub booted (output: ${b.output().slice(-2000)})`);
  } finally { b.cleanup(); }
});
