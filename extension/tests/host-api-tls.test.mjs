// Host API v1 TLS listener: the pinned client is accepted, a mismatched pin and plaintext never reach the gateway,
// the web Origin allowlist applies, and the plaintext listener refuses non-loopback peers.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-tls-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb } = await import('../kb/db.mjs');
const { loadOrCreateHostIdentity, resetHostIdentity } = await import('../server/host-identity.mjs');
const { startHostApiListener, upgradeRefusal, LISTENER_LIMITS } = await import('../server/host-api-listener.mjs');
const { pinnedUpgrade } = await import('./helpers/pinned-ws.mjs');

after(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

const other = loadOrCreateHostIdentity(getDb(), { hostName: 'Other' });
resetHostIdentity(getDb());
const identity = loadOrCreateHostIdentity(getDb(), { hostName: 'Test' });
assert.notEqual(other.fingerprint, identity.fingerprint);

function fakeGateway() {
  const g = { receive: () => {}, closed: () => {} };
  g.opened = () => { g.openedCount = (g.openedCount ?? 0) + 1; };
  return g;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const start = (opts = {}) => startHostApiListener({ gateway: opts.gateway ?? fakeGateway(), tls: { certPem: identity.certPem, keyPem: identity.keyPem }, basePort: 0, ...opts });

test('the pinned client with the right fingerprint upgrades (101) and opens one session', async () => {
  const gateway = fakeGateway();
  const l = await start({ gateway });
  const { status, socket } = await pinnedUpgrade({ port: l.port, fingerprint: identity.fingerprint });
  assert.equal(status, 101);
  await wait(50);
  assert.equal(gateway.openedCount, 1);
  socket.destroy();
  await l.close();
});

test('another identity\'s fingerprint is a pin_mismatch and never reaches the gateway', async () => {
  const gateway = fakeGateway();
  const l = await start({ gateway });
  await assert.rejects(pinnedUpgrade({ port: l.port, fingerprint: other.fingerprint }), /pin_mismatch/);
  await wait(300);
  assert.equal(gateway.openedCount, undefined);
  await l.close();
});

test('a plaintext upgrade to the TLS port errors and never reaches the gateway', async () => {
  const gateway = fakeGateway();
  const l = await start({ gateway });
  const err = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: l.port, path: '/host-api/v1',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('error', resolve);
    req.on('upgrade', (_res, s) => { s.destroy(); resolve(null); });
    req.on('response', (res) => { res.resume(); resolve(null); });
    req.end();
  });
  assert.ok(err && (err.code === 'ECONNRESET' || /socket hang up/.test(err.message)), String(err?.code ?? err));
  await wait(50);
  assert.equal(gateway.openedCount, undefined);
  await l.close();
});

test('the web Origin allowlist: a listed https origin upgrades, another is 403 origin_refused', async () => {
  const refused = [];
  const l = await start({ originAllowlist: ['https://app.example.com'], onRefused: (...a) => refused.push(a) });
  const ok = await pinnedUpgrade({ port: l.port, fingerprint: identity.fingerprint, origin: 'https://app.example.com' });
  assert.equal(ok.status, 101);
  ok.socket.destroy();
  const bad = await pinnedUpgrade({ port: l.port, fingerprint: identity.fingerprint, origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  bad.socket.destroy();
  assert.equal(refused.length, 1);
  assert.equal(refused[0][0], 'origin_refused');
  assert.equal(refused[0][2], 'https://evil.example');
  await l.close();
});

test('TLS binds every interface; plaintext binds loopback', async () => {
  const t = await start();
  assert.equal(t.address, '0.0.0.0');
  await t.close();
  const p = await startHostApiListener({ gateway: fakeGateway(), basePort: 0 });
  assert.equal(p.address, '127.0.0.1');
  await p.close();
});

test('upgradeRefusal: plaintext refuses a non-loopback peer; TLS does not; origin rule applies to both', () => {
  const req = (remoteAddress, headers = {}) => ({ url: '/host-api/v1', headers, socket: { remoteAddress } });
  assert.deepEqual(upgradeRefusal(req('192.168.1.20'), { tls: false, allowlist: [] }), { status: 403, event: 'plaintext_refused', detail: '' });
  assert.equal(upgradeRefusal(req('192.168.1.20'), { tls: true, allowlist: [] }), null);
  assert.equal(upgradeRefusal(req('127.0.0.1'), { tls: false, allowlist: [] }), null);
  assert.deepEqual(upgradeRefusal(req('192.168.1.20', { origin: 'https://evil.example' }), { tls: true, allowlist: [] }),
    { status: 403, event: 'origin_refused', detail: 'https://evil.example' });
  assert.deepEqual(upgradeRefusal({ ...req('127.0.0.1'), url: '/x' }, { tls: false, allowlist: [] }), { status: 404, event: null, detail: '' });
});

test('a reloaded identity pins the certificate actually served', async () => {
  const reloaded = loadOrCreateHostIdentity(getDb(), { hostName: 'Test' });
  assert.equal(reloaded.created, false);
  const l = await startHostApiListener({ gateway: fakeGateway(), tls: { certPem: reloaded.certPem, keyPem: reloaded.keyPem }, basePort: 0 });
  const { status, socket } = await pinnedUpgrade({ port: l.port, fingerprint: reloaded.fingerprint });
  assert.equal(status, 101);
  socket.destroy();
  await l.close();
});

const closedWithin = (sock, ms) => new Promise((resolve) => {
  const t = setTimeout(() => resolve(false), ms);
  sock.on('close', () => { clearTimeout(t); resolve(true); });
  sock.on('error', () => {});
});

test('a socket that never completes TLS is closed after the handshake timeout', async () => {
  const l = await start({ limits: { ...LISTENER_LIMITS, handshakeTimeoutMs: 300 } });
  const idle = net.connect(l.port, '127.0.0.1');
  const t0 = Date.now();
  assert.equal(await closedWithin(idle, 3000), true);
  assert.ok(Date.now() - t0 >= 250, 'not before the timeout');
  await l.close();
});

test('connections past the cap are refused', async () => {
  const gateway = fakeGateway();
  const l = await start({ gateway, limits: { ...LISTENER_LIMITS, maxConnections: 2 } });
  const held = [net.connect(l.port, '127.0.0.1'), net.connect(l.port, '127.0.0.1')];
  await Promise.all(held.map((s) => new Promise((r) => s.once('connect', r))));
  await wait(50);
  const third = net.connect(l.port, '127.0.0.1');
  assert.equal(await closedWithin(third, 1000), true, 'the third socket is dropped');
  await assert.rejects(pinnedUpgrade({ port: l.port, fingerprint: identity.fingerprint }));
  assert.equal(gateway.openedCount, undefined);
  for (const s of held) s.destroy();
  await l.close();
  assert.equal(LISTENER_LIMITS.maxConnections, 32);
  assert.equal(LISTENER_LIMITS.handshakeTimeoutMs, 10_000);
  assert.equal(LISTENER_LIMITS.requestTimeoutMs, 10_000);
});

test('TLS client errors are logged once per peer per minute, by code only', async () => {
  const lines = [];
  const l = await start({ log: (line) => lines.push(line) });
  for (let i = 0; i < 2; i++) {
    const s = net.connect(l.port, '127.0.0.1', () => s.write('GET /host-api/v1 HTTP/1.1\r\nHost: x\r\nX-Secret: hunter2\r\n\r\n'));
    await closedWithin(s, 2000);
  }
  await wait(50);
  const tlsLines = lines.filter((x) => /TLS handshake failed/.test(x));
  assert.equal(tlsLines.length, 1, JSON.stringify(lines));
  assert.match(tlsLines[0], /^Host API v1 TLS handshake failed from [0-9a-f:.]+: [A-Z0-9_]+$/);
  assert.ok(!/GET|hunter2/.test(tlsLines[0]));
  await l.close();
});
