// The desktop host writes `{"ids":["ecojclccfoegmlffpiahbcenmkfhadlk"]}` into the data dir of the core it spawns
// (desktop/src-tauri/src/core_env.rs pin_extension_ids). That core, on :3456, must echo CORS for our extension only.
// Spawns server.mjs, so it needs local listen permission (run with the sandbox disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_IDS_FILE } from '../core/extension-origins.mjs';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OURS = 'chrome-extension://ecojclccfoegmlffpiahbcenmkfhadlk';
const FOREIGN = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

test('the core the desktop spawns echoes CORS for our extension and refuses a foreign one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-extpin-core-'));
  // Byte for byte what the host writes.
  fs.writeFileSync(path.join(dir, EXTENSION_IDS_FILE), '{"ids":["ecojclccfoegmlffpiahbcenmkfhadlk"]}', { mode: 0o600 });
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port),
    LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DATA_DIR: dir,
    LLMIDE_DB_PATH: path.join(dir, 'data.db'),
    LLMIDE_JWT_SECRET: 'a'.repeat(48),
    LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    LLMIDE_ENGINE_PREWARM: '0',
  };
  delete env.NODE_TEST_CONTEXT; // a test run never reads a data dir, so the pin would not load
  delete env.LLMIDE_CORS_ORIGINS;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (Date.now() > deadline || child.exitCode != null) throw new Error('server never became healthy');
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const acao = async (origin, method = 'GET') => {
      const headers = { Origin: origin };
      if (method === 'OPTIONS') headers['Access-Control-Request-Method'] = 'POST';
      const r = await fetch(`http://127.0.0.1:${port}/health`, { method, headers });
      return r.headers.get('access-control-allow-origin');
    };
    assert.equal(await acao(OURS), OURS);
    assert.equal(await acao(OURS, 'OPTIONS'), OURS, 'preflight');
    assert.equal(await acao(FOREIGN), null, 'a foreign extension is refused');
    assert.equal(await acao(FOREIGN, 'OPTIONS'), null, 'and so is its preflight');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
