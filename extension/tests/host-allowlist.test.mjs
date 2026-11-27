// The Host-header check that stops DNS rebinding against the loopback core. The pure function is tested
// directly; the HTTP test boots server.mjs and sends a real `Host: attacker.example` (needs local listen,
// so run it with the sandbox disabled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHostAllowed } from '../server/host-allowlist.mjs';

const LOCAL = { hub: false, allowRemote: false, allowedHosts: [] };

test('loopback names are allowed with or without a port, in any case, with one trailing dot', () => {
  for (const host of [
    'localhost', 'localhost:3456', 'LOCALHOST:3456', 'LocalHost.', 'localhost.:3456',
    '127.0.0.1', '127.0.0.1:3456', '127.0.0.1.:80', '127.1.2.3:9', '127.255.255.255',
    '[::1]', '[::1]:3456', '[0:0:0:0:0:0:0:1]:3456',
  ]) assert.equal(isHostAllowed(host, LOCAL), true, host);
});

test('anything that is not loopback is refused, including look-alikes', () => {
  for (const host of [
    'attacker.example', 'attacker.example:3456', '127.0.0.1.attacker.example', 'localhost.attacker.example',
    'attacker.example.127.0.0.1', '128.0.0.1', '10.0.0.1:3456', '0.0.0.0', '192.168.1.5', 'localhost..',
    '[::2]', '[::ffff:127.0.0.1]', '[2001:db8::1]:3456',
  ]) assert.equal(isHostAllowed(host, LOCAL), false, host);
});

test('a malformed Host is refused', () => {
  for (const host of [
    'localhost:', 'localhost:abc', 'localhost:99999999', 'local host', 'localhost/evil', 'user@localhost',
    '127.0.0.1:80:80', '::1', '[::1', '[::1]x', '[::1]:', '[zz]', '-.', '.', ':3456', 'localhost\r\nX: y', '127.0.0.256',
  ]) assert.equal(isHostAllowed(host, LOCAL), false, JSON.stringify(host));
});

test('a missing or empty Host is allowed (not a browser vector)', () => {
  assert.equal(isHostAllowed(undefined, LOCAL), true);
  assert.equal(isHostAllowed('', LOCAL), true);
});

test('LLMIDE_ALLOWED_HOSTS adds exact hostnames only', () => {
  const settings = { ...LOCAL, allowedHosts: ['Core.Example.', 'dev-box'] };
  for (const host of ['core.example', 'CORE.example:8443', 'dev-box:3456']) assert.equal(isHostAllowed(host, settings), true, host);
  for (const host of ['evil.core.example', 'core.example.evil', 'dev-boxx', 'attacker.example']) {
    assert.equal(isHostAllowed(host, settings), false, host);
  }
  assert.equal(isHostAllowed('localhost', settings), true);
});

test('a hub or a remote-mode core skips the check', () => {
  assert.equal(isHostAllowed('hub.example.com', { ...LOCAL, hub: true }), true);
  assert.equal(isHostAllowed('192.168.1.5:3456', { ...LOCAL, allowRemote: true }), true);
  assert.equal(isHostAllowed('hub.example.com', LOCAL), false);
});

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function request(port, method, hostHeader, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method, headers: { Host: hostHeader, ...headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a real server answers 403 HOST_NOT_ALLOWED to a foreign Host and serves a loopback one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-host-'));
  const port = await freePort();
  const env = { ...process.env, LLMIDE_PORT: String(port), LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'kb.db'), LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0', LLMIDE_ENGINE_PREWARM: '0', LLMIDE_ALLOWED_HOSTS: 'core.example' };
  delete env.NODE_TEST_CONTEXT; delete env.LLMIDE_HUB; delete env.LLMIDE_ALLOW_REMOTE;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: 'ignore' });
  try {
    const deadline = Date.now() + 20_000;
    for (;;) {
      if (Date.now() > deadline || child.exitCode != null) throw new Error('server never became healthy');
      try { if ((await request(port, 'GET', `127.0.0.1:${port}`)).status === 200) break; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal((await request(port, 'GET', `localhost:${port}`)).status, 200);
    assert.equal((await request(port, 'GET', 'core.example')).status, 200, 'LLMIDE_ALLOWED_HOSTS entry');

    for (const method of ['GET', 'OPTIONS']) {
      const res = await request(port, method, 'attacker.example', { Origin: 'http://attacker.example' });
      assert.equal(res.status, 403, method);
      assert.equal(JSON.parse(res.body).error.code, 'HOST_NOT_ALLOWED');
      assert.equal(res.headers['access-control-allow-origin'], undefined, 'no CORS headers on a refusal');
      assert.equal(res.body.includes('attacker.example'), false, 'the Host value is not echoed');
    }
    assert.equal((await request(port, 'GET', `127.0.0.1.attacker.example:${port}`)).status, 403);
  } finally { child.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});
