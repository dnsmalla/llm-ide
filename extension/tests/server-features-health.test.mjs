// End-to-end: a real `node server.mjs` honours LLMIDE_FEATURES in /health —
// `features` reports the effective set and `endpoints` drops a disabled
// group's routes — while every endpoint the Chrome extension requires
// (src/sidepanel/App.tsx REQUIRED_ENDPOINTS) survives ANY feature set, so the
// side panel never reports a pruned Mac-only server as "stale".
//
// Spawns the server on a free loopback port, so this needs local listen
// permission (run the suite with the sandbox disabled).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requiredEndpoints() {
  const src = fs.readFileSync(path.join(EXT, 'src/sidepanel/App.tsx'), 'utf8');
  const block = src.match(/const REQUIRED_ENDPOINTS = \[([\s\S]*?)\];/);
  assert.ok(block, 'REQUIRED_ENDPOINTS array found in App.tsx');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function withServer(features, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-features-health-'));
  const port = await freePort();
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'),
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    // The health checks never need the chat engine; skip the post-listen prewarm
    // so the spawned server is not charged ~65 ms of import on every run.
    LLMIDE_ENGINE_PREWARM: '0',
  };
  // The node test runner marks its children; the server must boot as itself.
  delete env.NODE_TEST_CONTEXT;
  if (features == null) delete env.LLMIDE_FEATURES; else env.LLMIDE_FEATURES = features;
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
        if (r.ok) { health = await r.json(); break; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(health, `server answered /health (output: ${output.slice(-2000)})`);
    await fn(health, output);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => (child.exitCode != null ? r() : child.once('exit', r)));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('/health with LLMIDE_FEATURES=agent_chat: features listed, pruned endpoints gone, Chrome endpoints kept', async () => {
  await withServer('agent_chat', (health, output) => {
    assert.deepEqual(health.features, ['agent_chat']);
    assert.ok(health.apiVersion >= 75);
    for (const pruned of ['/kb/loop/agent-run', '/kb/issue-schedule', '/kb/ingest-code-graph']) {
      assert.ok(!health.endpoints.includes(pruned), `${pruned} is not advertised`);
    }
    const missing = requiredEndpoints().filter((e) => !health.endpoints.includes(e));
    assert.deepEqual(missing, [], 'Chrome REQUIRED_ENDPOINTS survive a minimal feature set');
    assert.doesNotMatch(output, /LLMIDE_FEATURES/, 'a valid list logs no warning');
  });
});

test('/health with LLMIDE_FEATURES unset: features null and the full endpoint list', async () => {
  await withServer(null, (health) => {
    assert.equal(health.features, null);
    for (const ep of ['/kb/loop/agent-run', '/kb/issue-schedule', '/kb/ingest-code-graph', '/generate-doc']) {
      assert.ok(health.endpoints.includes(ep), ep);
    }
    const missing = requiredEndpoints().filter((e) => !health.endpoints.includes(e));
    assert.deepEqual(missing, []);
  });
});
