// CORS stays a strict allowlist (echo Origin, never `*`). The desktop host starts the core it SPAWNS with
// LLMIDE_CORS_ORIGINS set to exactly the packaged webview origins; without that env those origins are refused,
// and an unknown origin is refused either way. Needs local listen permission (run with the sandbox disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEBVIEW = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function withServer(corsEnv, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-cors-'));
  const port = await freePort();
  const env = { ...process.env, LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0' };
  delete env.NODE_TEST_CONTEXT; delete env.LLMIDE_CORS_ORIGINS;
  if (corsEnv !== undefined) env.LLMIDE_CORS_ORIGINS = corsEnv;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (Date.now() > deadline || child.exitCode != null) throw new Error('server never became healthy');
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const acao = async (origin, method = 'GET') => {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { method, headers: { Origin: origin, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET' } : {}) } });
      return r.headers.get('access-control-allow-origin');
    };
    return await fn(acao);
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('without LLMIDE_CORS_ORIGINS the webview origins and strangers are refused; loopback is echoed', async () => {
  await withServer(undefined, async (acao) => {
    for (const o of [...WEBVIEW, 'https://evil.example', 'null']) assert.equal(await acao(o), null, o);
    assert.equal(await acao('http://127.0.0.1:5173'), 'http://127.0.0.1:5173');
  });
});

test('with the env set exactly those origins are echoed (never *), anything else is still refused', async () => {
  await withServer(WEBVIEW.join(','), async (acao) => {
    for (const o of WEBVIEW) { assert.equal(await acao(o), o, o); assert.equal(await acao(o, 'OPTIONS'), o, `preflight ${o}`); }
    for (const o of ['https://evil.example', 'http://tauri.localhost.evil.example', 'tauri://localhost.evil.example', 'tauri://evil', 'http://tauri.localhost:8080', 'null', '*']) {
      assert.equal(await acao(o), null, o);
    }
  });
});

test('a wildcard in the env is not a wildcard', async () => {
  await withServer('*', async (acao) => {
    assert.equal(await acao('https://evil.example'), null);
    assert.equal(await acao('tauri://localhost'), null);
  });
});
