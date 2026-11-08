// Host API pairing on a hub (REQ-014 B2): there is no desktop-spawned host proof on a VPS, so in hub mode the
// member's JWT + the `member` team role replace it; outside hub mode the proof stays mandatory. The role is
// read from the `members` row, never from the JWT.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const pinDir = fs.mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "_hub-pin-"));
process.env.LLMIDE_HOST_API_FINGERPRINT_FILE = path.join(pinDir, "pin");
fs.writeFileSync(process.env.LLMIDE_HOST_API_FINGERPRINT_FILE, "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
process.env.LLMIDE_HUB_PUBLIC_URL = "wss://hub.example.com/host-api/v1";
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_host-api-hub-pairing-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { handleHostApiRoute } = await import('../routes/host-api/http-routes.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `hub-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'h' }).id;
const setRole = (id, role) => kb.getDb().prepare('UPDATE members SET team_role = ? WHERE user_id = ?').run(role, id);

const state = { userId: null, hub: true };
const hostApi = { listener: { port: 3016 }, gateway: { disconnectDevice: () => true } };
const server = http.createServer((req, res) => {
  req.user = { id: state.userId };
  void handleHostApiRoute(req, res, { hostApi: () => hostApi, enabled: true, hub: state.hub, logger: undefined, audit: () => ({ record: () => {} }) });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(pinDir, { recursive: true, force: true }); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

async function call(method, p, { proof } = {}) {
  const r = await fetch(base + p, { method, headers: proof ? { 'x-llmide-host-nonce': proof } : {} });
  return { status: r.status, body: await r.json() };
}

test('hub mode: a member mints a PIN, lists devices and reads push status with no proof header', async () => {
  state.hub = true;
  state.userId = user(); // registerUser grants an engineer (role member)
  const pin = await call('POST', '/host-api/pin');
  assert.equal(pin.status, 200, JSON.stringify(pin.body));
  assert.match(pin.body.pin, /^[0-9]{6}$/);
  assert.equal(pin.body.port, 443);
  assert.equal(pin.body.url, 'wss://hub.example.com/host-api/v1');
  assert.equal(pin.body.fingerprint, 'sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.deepEqual(pin.body.addresses, ['hub.example.com']);
  assert.equal((await call('GET', '/host-api/devices')).status, 200);
  assert.equal((await call('GET', '/host-api/push/status')).status, 200);
  assert.equal((await call('DELETE', '/host-api/devices/h1-none')).status, 200);
});

test('hub mode: a viewer is refused ROLE_DENIED — the proof is not a way around the team role', async () => {
  state.hub = true;
  const v = user();
  setRole(v, 'viewer');
  state.userId = v;
  for (const [m, p] of [['POST', '/host-api/pin'], ['GET', '/host-api/devices'], ['GET', '/host-api/push/status']]) {
    const r = await call(m, p);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.error.code, 'ROLE_DENIED');
  }
});

test('outside hub mode: the bus host proof is still required', async () => {
  state.hub = false;
  const v = user();
  setRole(v, 'viewer');
  state.userId = v;
  const refused = await call('POST', '/host-api/pin');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'HOST_PROOF_REQUIRED');
});
