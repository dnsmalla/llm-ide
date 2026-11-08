// The desktop hands the spawned core its three secrets on stdin instead of in the environment (a same-user process
// can read `ps eww` / /proc/<pid>/environ). Booted in production with no secret env at all, the core only starts if
// it read the JSON line: then /health answers and /auth/login mints a token. Spawns `node server.mjs`, so it needs
// local listen.
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
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('LLMIDE_SECRETS_STDIN=1: the core takes its secrets from one stdin line and serves /health + /auth/login', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-secrets-stdin-'));
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir, LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_LOG_FILE: 'none',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
    LLMIDE_DISABLE_REGISTRATION: '0',
    LLMIDE_SECRETS_STDIN: '1',
  };
  for (const k of ['LLMIDE_JWT_SECRET', 'LLMIDE_VAULT_KEY', 'LLMIDE_HOST_APPROVAL_KEY', 'NODE_TEST_CONTEXT']) delete env[k];
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  // One JSON line, then the host closes the pipe; the core must not echo it.
  child.stdin.write(`${JSON.stringify({ jwtSecret: 'j'.repeat(48), vaultKey: 'v'.repeat(48), hostApprovalKey: 'a'.repeat(64) })}\n`);
  child.stdin.end();
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    let health = null;
    while (Date.now() < deadline && child.exitCode == null) {
      try { const r = await fetch(`${base}/health`); if (r.ok) { health = await r.json(); break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, `server answered /health (output: ${output.slice(-2000)})`);
    assert.doesNotMatch(output, /j{48}|v{48}/, 'the core never echoes the secrets');
    const post = (p, o) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
    assert.equal((await post('/auth/register', { email: 'stdin@example.com', password: 'CorrectHorseBattery', displayName: 'S' })).status, 201);
    const login = await post('/auth/login', { email: 'stdin@example.com', password: 'CorrectHorseBattery' });
    assert.equal(login.status, 200);
    assert.ok((await login.json()).accessToken, 'a token signed with the stdin JWT secret');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without LLMIDE_SECRETS_STDIN a production boot still needs the secret env vars', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-secrets-env-'));
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir, LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_LOG_FILE: 'none',
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_BCRYPT_COST: '10',
  };
  for (const k of ['LLMIDE_JWT_SECRET', 'LLMIDE_VAULT_KEY', 'LLMIDE_HOST_APPROVAL_KEY', 'LLMIDE_SECRETS_STDIN', 'NODE_TEST_CONTEXT']) delete env[k];
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  try {
    const code = await Promise.race([new Promise((r) => child.once('exit', r)), new Promise((r) => setTimeout(() => r('timeout'), 20_000))]);
    assert.equal(code, 1, `a secret-less production boot exits 1 (output: ${output.slice(-2000)})`);
    assert.match(output, /LLMIDE_JWT_SECRET/);
  } finally {
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
