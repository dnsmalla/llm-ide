// Host API v1 host-only routes (routes/host-api/http-routes.mjs): JWT user + bus host proof, then the dev flag.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const KEY_HEX = 'c3'.repeat(32);
const env = { LLMIDE_HOST_APPROVAL_KEY: KEY_HEX };
const PROOF = crypto.createHmac('sha256', Buffer.from(KEY_HEX, 'hex')).update('bus-host-proof/v1').digest('hex');

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const dev = await import('../kb/host-api-devices.mjs');
const pins = await import('../routes/host-api/pin.mjs');
const { handleHostApiRoute } = await import('../routes/host-api/http-routes.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `r-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id;

const state = { userId: null, enabled: true };
const disconnects = [];
const hostApi = { listener: { port: 3016 }, gateway: { disconnectDevice: (u, d) => disconnects.push([u, d]) } };
const server = http.createServer((req, res) => {
  req.user = { id: state.userId };
  void handleHostApiRoute(req, res, { hostApi: () => hostApi, enabled: state.enabled, env });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

async function call(method, p, { proof = PROOF } = {}) {
  const r = await fetch(base + p, { method, headers: proof ? { 'x-llmide-host-nonce': proof } : {} });
  return { status: r.status, body: await r.json() };
}

test('without the host proof every route answers 403 HOST_PROOF_REQUIRED, even with the flag off', async () => {
  state.userId = user();
  for (const enabled of [true, false]) {
    state.enabled = enabled;
    for (const [m, p] of [['POST', '/host-api/pin'], ['GET', '/host-api/devices'], ['DELETE', '/host-api/devices/h1-x']]) {
      const r = await call(m, p, { proof: null });
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, 'HOST_PROOF_REQUIRED');
    }
    assert.equal((await call('POST', '/host-api/pin', { proof: 'ab'.repeat(32) })).status, 403, 'a wrong proof');
  }
  state.enabled = true;
});

test('with the proof but the flag off: 404 HOST_API_DISABLED', async () => {
  state.userId = user();
  state.enabled = false;
  for (const [m, p] of [['POST', '/host-api/pin'], ['GET', '/host-api/devices'], ['DELETE', '/host-api/devices/h1-x']]) {
    const r = await call(m, p);
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'HOST_API_DISABLED');
  }
  state.enabled = true;
});

test('the flag on: a six-digit PIN for the caller, with the listener port', async () => {
  const u = user();
  state.userId = u;
  const r = await call('POST', '/host-api/pin');
  assert.equal(r.status, 200);
  assert.match(r.body.pin, /^[0-9]{6}$/);
  assert.equal(r.body.port, 3016);
  assert.ok(r.body.expiresAt > Date.now());
  assert.equal(pins.consumePin(r.body.pin), u, 'the PIN belongs to the user who minted it');
});

test('GET lists the device, DELETE revokes it and disconnects; another user gets revoked:false', async () => {
  const u = user();
  const other = user();
  const { deviceId, token } = dev.issueDeviceToken(u, 'iPhone');
  state.userId = u;
  const list = await call('GET', '/host-api/devices');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.devices.map((d) => [d.deviceId, d.name]), [[deviceId, 'iPhone']]);
  assert.deepEqual(Object.keys(list.body.devices[0]).sort(), ['deviceId', 'lastSeenAt', 'name', 'pairedAt']);
  assert.ok(!JSON.stringify(list.body).includes(token));

  state.userId = other;
  assert.deepEqual((await call('DELETE', `/host-api/devices/${deviceId}`)).body, { revoked: false });
  assert.ok(dev.authenticateDeviceToken(token), 'still paired');

  state.userId = u;
  disconnects.length = 0;
  assert.deepEqual((await call('DELETE', `/host-api/devices/${deviceId}`)).body, { revoked: true });
  assert.deepEqual(disconnects, [[u, deviceId]]);
  assert.equal(dev.authenticateDeviceToken(token), null);
  assert.deepEqual((await call('GET', '/host-api/devices')).body, { devices: [] });
});

test('a malformed device id is 400; the PIN route without a listener is 503', async () => {
  state.userId = user();
  assert.equal((await call('DELETE', `/host-api/devices/${'x'.repeat(65)}`)).status, 400);
  const saved = hostApi.listener;
  hostApi.listener = null;
  const r = await call('POST', '/host-api/pin');
  hostApi.listener = saved;
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'HOST_API_UNAVAILABLE');
});

// Last: it breaks the device table for the rest of this file.
test('a store failure answers a JSON 500, never a hung request', async () => {
  state.userId = user();
  kb.getDb().exec('DROP TABLE host_api_devices');
  for (const [m, p] of [['GET', '/host-api/devices'], ['DELETE', '/host-api/devices/h1-x']]) {
    const r = await call(m, p);
    assert.equal(r.status, 500);
    assert.equal(typeof r.body.error.code, 'string');
  }
});
