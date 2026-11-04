// Host API v1 TLS listener: the pinned client is accepted, a mismatched pin and plaintext never reach the gateway,
// the web Origin allowlist applies, and the plaintext listener refuses non-loopback peers.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-tls-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { getDb } = await import('../kb/db.mjs');
const { loadOrCreateHostIdentity, resetHostIdentity } = await import('../server/host-identity.mjs');
const { startHostApiListener, upgradeRefusal } = await import('../server/host-api-listener.mjs');
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
