import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const st = await import('../kb/sync-state.mjs');
const { handleSyncRoute, isSyncRoute } = await import('../routes/sync/http-routes.mjs');
const { recordCycleFailure, publishNow, withUserLock } = await import('../routes/sync/scheduler.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');
const { _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');
const PROOF = busHostProof();

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sr-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id;
async function call(method, url, { userId, body, proof = true, deps } = {}) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, user: userId ? { id: userId } : undefined, headers: proof ? { 'x-llmide-host-nonce': PROOF } : {},
    socket: { remoteAddress: '127.0.0.1' }, pause() {}, resume() {},
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end') cb(); return req; } };
  let status = 0; let payload = '';
  const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, setHeader() {}, end(b) { payload = b ?? ''; } };
  await handleSyncRoute(req, res, deps ? { deps } : {});
  return { status, body: payload ? JSON.parse(payload) : null };
}
const MEGA = { email: 'llmide-sync@example.com', password: 'a long dedicated password', folder: 'llmide-sync' };

test('routes need the bus host proof, then a user', async () => {
  assert.ok(isSyncRoute('/kb/sync/status'));
  assert.ok(!isSyncRoute('/kb/synchronize'));
  assert.equal((await call('GET', '/kb/sync/status', { userId: user(), proof: false })).status, 403);
  assert.equal((await call('GET', '/kb/sync/status', {})).status, 401);
});

test('MEGA setup validates, keeps the login only in the vault, and never returns it', async () => {
  const u = user();
  const bad = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, email: 'not-an-email' } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'email');
  const badFolder = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, folder: '../up' } });
  assert.equal(badFolder.body.error.details.field, 'folder');
  const a = await call('POST', '/kb/sync/mega', { userId: u, body: { email: MEGA.email, password: MEGA.password } });
  assert.equal(a.status, 200);
  assert.equal(a.body.storeKind, 'mega');
  assert.deepEqual(a.body.store, { folder: 'llmide-sync', account: 'l***@example.com' }, 'the default folder name applies');
  assert.equal(a.body.enabled, false);
  const raw = JSON.stringify(a.body);
  assert.ok(!raw.includes(MEGA.password)); assert.ok(!raw.includes(MEGA.email));
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaPassword'), MEGA.password);
  assert.deepEqual(st.getSyncState(u).storeConfig, { folder: 'llmide-sync' }, 'the database holds the folder name only');
});

test('enable needs a configured store; status reflects it', async () => {
  const u = user();
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } })).status, 409);
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  const on = await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: true } });
  assert.equal(on.body.enabled, true);
  assert.equal((await call('POST', '/kb/sync/enabled', { userId: u, body: { enabled: 'yes' } })).status, 400);
});

test('test and publish surface coded store errors', async () => {
  const u = user();
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  const failing = { storeFor: () => ({ put: async () => { throw Object.assign(new Error('x'), { code: 'SYNC_MFA_REQUIRED' }); }, get: async () => null, remove: async () => {} }) };
  const r = await call('POST', '/kb/sync/test', { userId: u, deps: failing });
  assert.equal(r.status, 502); assert.equal(r.body.error.code, 'SYNC_MFA_REQUIRED');
});

test('a refused login turns sync off instead of retrying (no account lockout); rate limits back off', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  st.setSyncEnabled(u, true);
  const backoff = new Map();
  const ms = recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_RATE_LIMITED' }), { now: 1000, backoff });
  assert.equal(ms, 60_000);
  assert.equal(st.getSyncState(u).enabled, true);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_RATE_LIMITED');
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_AUTH_FAILED' }), { now: 2000, backoff });
  assert.equal(st.getSyncState(u).enabled, false);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_AUTH_FAILED');
});

test('changing the MEGA account or folder forgets published blobs and forces fresh key/wrap files', async () => {
  const u = user();
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  st.addSyncDevice(u, { deviceId: 'h1-sync-1', dir: 'E'.repeat(22), tier: 'web', name: 'Phone', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  st.setPublished(u, 'h1-sync-1', 'chats', { file: 's/' + 'a'.repeat(32) + '.bin', seq: 1, fileSha256: 'f', plainSha256: 'p', epoch: 1 });
  st.setDeviceWrapEpoch(u, 'h1-sync-1', 1);
  const next = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, folder: 'llmide-sync-2' } });
  assert.equal(next.status, 200);
  assert.deepEqual(st.getPublished(u, 'h1-sync-1'), {});
  assert.equal(st.listSyncDevices(u)[0].wrapEpoch, 0);
  const same = await call('POST', '/kb/sync/mega', { userId: u, body: { ...MEGA, folder: 'llmide-sync-2' } });
  assert.equal(same.status, 200);
  assert.deepEqual(st.getPublished(u, 'h1-sync-1'), {}, 'same folder keeps the reset state');
});

test('manual publish shares the scheduler per-user lock and refuses instead of waiting for turns', async () => {
  const u = user();
  await withUserLock(u, async () => {
    await assert.rejects(() => publishNow(u, { store: {} }), (e) => e.code === 'SYNC_BUSY');
  });
});

test('device enrollment over the routes: QR, SAS, confirm, list, revoke, rotate', async () => {
  _resetEnrollmentsForTest();
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const store = createMemoryStore();
  const deps = { storeFor: () => store };
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'android' }, deps })).body.error.details.field, 'tier');
  const start = await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, deps });
  assert.equal(start.status, 200); assert.ok(start.body.qr.startsWith('llmide://pair?'));
  assert.equal((await call('POST', '/kb/sync/devices/enroll/confirm', { userId: u, body: {}, deps })).body.error.code, 'ENROLL_NOT_READY');
  const dev = createReferenceDevice({ name: 'Route phone' });
  await dev.scanAndClaim(store, start.body.qr);
  const poll = await call('POST', '/kb/sync/devices/enroll/poll', { userId: u, body: {}, deps });
  assert.equal(poll.body.phase, 'confirm');
  assert.equal(await dev.readAck(store), poll.body.sas);
  const done = await call('POST', '/kb/sync/devices/enroll/confirm', { userId: u, body: {}, deps });
  assert.equal(done.status, 200);
  assert.equal(done.body.devices[0].name, 'Route phone');
  assert.equal(done.body.devices[0].folderHint.length, 6);
  assert.equal(done.body.rotationPending, false);
  const raw = JSON.stringify(done.body);
  assert.ok(!raw.includes(dev.pair.dir) && !raw.includes(start.body.qr.match(/es=([^&]+)/)[1]), 'no folder capability or es in status');
  const e0 = done.body.epoch;
  const rot = await call('POST', '/kb/sync/rotate', { userId: u, body: {}, deps });
  assert.equal(rot.body.epoch, e0 + 1);
  assert.equal((await call('DELETE', '/kb/sync/devices/AAAAAAAAAAAAAAAAAAAAAA', { userId: u, deps })).status, 404);
  const rev = await call('DELETE', `/kb/sync/devices/${dev.deviceId}`, { userId: u, deps });
  assert.equal(rev.status, 200); assert.deepEqual(rev.body.devices, []); assert.equal(rev.body.epoch, e0 + 2);
  assert.equal((await call('POST', '/kb/sync/devices/enroll/cancel', { userId: u, body: {}, deps })).body.ok, true);
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, proof: false, deps })).status, 403);
});

test('enrollment needs a store and sync on', async () => {
  const u = user();
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' } })).body.error.code, 'SYNC_NOT_SET_UP');
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  const store = createMemoryStore();
  assert.equal((await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, deps: { storeFor: () => store } })).body.error.code, 'SYNC_OFF');
});
