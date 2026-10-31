// A real `node server.mjs` echoes LLMIDE_CORE_NONCE as the x-llmide-nonce
// response header on /health (the desktop host's identity check), and sends
// no such header when none was configured. The JSON body is unchanged.
// Needs local listen permission (run with the sandbox disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function health(nonce) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-nonce-'));
  const port = await freePort();
  const env = { ...process.env, LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0' };
  delete env.NODE_TEST_CONTEXT; delete env.LLMIDE_CORE_NONCE;
  if (nonce !== undefined) env.LLMIDE_CORE_NONCE = nonce;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && child.exitCode == null) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.status === 200) return { header: r.headers.get('x-llmide-nonce'), body: await r.json() };
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('server never became healthy');
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('/health echoes a well-formed nonce in a header, body unchanged', async () => {
  const nonce = 'ab12'.repeat(8);
  const { header, body } = await health(nonce);
  assert.equal(header, nonce);
  assert.ok(!JSON.stringify(body).includes(nonce), 'nonce must not appear in the JSON body');
});

test('no nonce header without a configured nonce or with a malformed one', async () => {
  assert.equal((await health(undefined)).header, null);
  assert.equal((await health('not hex!')).header, null);
});
