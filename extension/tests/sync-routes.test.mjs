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
const { listActivity } = await import('../kb/activity.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const st = await import('../kb/sync-state.mjs');
const { handleSyncRoute, isSyncRoute } = await import('../routes/sync/http-routes.mjs');
const { recordCycleFailure, publishNow, withUserLock, storeFor, dropStore } = await import('../routes/sync/scheduler.mjs');
const { createFakeBox } = await import('./helpers/fake-box.mjs');
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

test('a revoke during a publish never leaves files in the revoked device folder (review I1)', async () => {
  _resetEnrollmentsForTest();
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const store = createMemoryStore();
  const deps = { storeFor: () => store };
  const start = await call('POST', '/kb/sync/devices/enroll', { userId: u, body: { tier: 'ios' }, deps });
  const dev = createReferenceDevice({ name: 'Revoked phone' });
  await dev.scanAndClaim(store, start.body.qr);
  await call('POST', '/kb/sync/devices/enroll/poll', { userId: u, body: {}, deps });
  assert.equal((await call('POST', '/kb/sync/devices/enroll/confirm', { userId: u, body: {}, deps })).status, 200);
  const base = `${st.getSyncState(u).syncId}/d/${dev.pair.dir}`;
  st.setDeviceWrapEpoch(u, dev.deviceId, 0); // the next publish rewrites key.bin + wrap.bin first
  let release; let held = false;
  const put = store.put.bind(store);
  store.put = async (p, b) => { if (!held && p.startsWith(base)) { held = true; await new Promise((r) => { release = r; }); } return put(p, b); };
  const pub = publishNow(u, { store });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(held, 'the publish is held in a write to the device folder');
  const rev = await call('DELETE', `/kb/sync/devices/${dev.deviceId}`, { userId: u, deps });
  release();
  await pub;
  const files = async () => [...store.dump().keys()].filter((k) => k.startsWith(`${base}/`));
  if (rev.status === 200) assert.deepEqual(await files(), [], 'a revoke that succeeded leaves the folder empty');
  else assert.equal(rev.body.error.code, 'SYNC_BUSY');
  const again = await call('DELETE', `/kb/sync/devices/${dev.deviceId}`, { userId: u, deps });
  if (rev.status !== 200) assert.equal(again.status, 200);
  assert.deepEqual(await files(), [], 'nothing was recreated');
  assert.equal(st.listSyncDevices(u).length, 0);
});

test('a changed SFTP host key turns sync off, and sync.sshKey is internal', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'sftp', storeConfig: { host: 'sync.example.com', port: 22, username: 'llmidesync', hostFingerprint: `SHA256:${'A'.repeat(43)}`, webHost: 'llm-ide.com', root: '/data' } });
  st.setSyncEnabled(u, true);
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_CHANGED' }), { now: 1, backoff: new Map() });
  assert.equal(st.getSyncState(u).enabled, false);
  assert.equal(st.getSyncState(u).lastError, 'SYNC_HOST_KEY_CHANGED');
  assert.equal(vault.isUserSettableVaultKey('sync.sshKey'), false);
  assert.ok(!vault.VAULT_KEYS.includes('sync.sshKey'));
});

const SFTP={host:'sync.example.com',hostFingerprint:'256 SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM root@vps (ED25519)'};
test('own-server setup validates and keeps one generated key',async()=>{const u=user();const bad=await call('POST','/kb/sync/sftp',{userId:u,body:{...SFTP,hostFingerprint:'MD5:aa'}});assert.equal(bad.status,400);assert.equal(bad.body.error.details.field,'hostFingerprint');assert.equal((await call('POST','/kb/sync/sftp',{userId:u,body:{...SFTP,webHost:'localhost'}})).body.error.details.field,'webHost');const a=await call('POST','/kb/sync/sftp',{userId:u,body:SFTP});assert.equal(a.status,200);assert.equal(a.body.storeKind,'sftp');const{publicKey,...rest}=a.body.store;assert.deepEqual(rest,{host:'sync.example.com',port:22,username:'llmidesync',hostFingerprint:'SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM',webHost:'llm-ide.com'});assert.match(publicKey,new RegExp(`^ssh-ed25519 [A-Za-z0-9+/=]+ llmide-sync-${a.body.syncId}$`));const priv=vault.getSecret(kb.getDb(),u,'sync.sshKey');assert.match(priv,/^-----BEGIN OPENSSH PRIVATE KEY-----/);assert.ok(!JSON.stringify(a.body).includes('PRIVATE KEY'));const again=await call('POST','/kb/sync/sftp',{userId:u,body:{...SFTP,port:2222}});assert.equal(again.body.store.publicKey,publicKey);assert.equal(again.body.store.port,2222);assert.equal(vault.getSecret(kb.getDb(),u,'sync.sshKey'),priv)});
test('switching storage kind unlinks devices, forgets the old login and resets publish state', async () => {
  const u = user();
  await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  st.addSyncDevice(u, { deviceId: 'sw-device-1', dir: 'F'.repeat(22), tier: 'web', name: 'Phone', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  st.setPublished(u, 'sw-device-1', 'chats', { file: 's/' + 'b'.repeat(32) + '.bin', seq: 1, fileSha256: 'f', plainSha256: 'p', epoch: 1 });
  const s = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.devices, []);
  assert.deepEqual(st.getPublished(u, 'sw-device-1'), {});
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaPassword'), null);
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.megaEmail'), null);
  st.addSyncDevice(u, { deviceId: 'sw-device-2', dir: 'G'.repeat(22), tier: 'ios', name: 'Phone 2', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([3]), now: 2 });
  const m = await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
  assert.equal(m.body.storeKind, 'mega');
  assert.deepEqual(m.body.devices, [], 'back to MEGA unlinks the own-server devices too');
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.sshKey'), null, 'the SSH key goes with the own-server setup');
});

test('setup refuses while a sync cycle holds the lock', async () => {
  const u = user();
  await withUserLock(u, async () => {
    const r = await call('POST', '/kb/sync/sftp', { userId: u, body: SFTP });
    assert.equal(r.status, 409); assert.equal(r.body.error.code, 'SYNC_BUSY');
    const m = await call('POST', '/kb/sync/mega', { userId: u, body: MEGA });
    assert.equal(m.status, 409); assert.equal(m.body.error.code, 'SYNC_BUSY');
  });
});

test('storeFor builds a Box store and persists rotated refresh tokens', async () => {
  const fake = createFakeBox(); const real = globalThis.fetch; globalThis.fetch = fake.fetch;
  try { const u = user(); st.ensureSyncState(u, { storeKind: 'box', storeConfig: { clientId: fake.clientId, folder: 'llmide-sync', account: 's***@example.com' } });
    assert.equal(storeFor(u), null); const first = fake.grant(); vault.setSecret(kb.getDb(), u, 'sync.boxClientSecret', fake.clientSecret); vault.setSecret(kb.getDb(), u, 'sync.boxRefreshToken', first);
    const s = storeFor(u); assert.equal(s.describe().kind, 'box'); await s.put('x/a.bin', Buffer.from('1'));
    const now = vault.getSecret(kb.getDb(), u, 'sync.boxRefreshToken'); assert.ok(now && now !== first); await dropStore(u);
  } finally { globalThis.fetch = real; }
});
test('Box secrets are server-internal', () => { for (const k of ['sync.boxClientSecret','sync.boxRefreshToken']) { assert.equal(vault.isUserSettableVaultKey(k), false); assert.ok(!vault.VAULT_KEYS.includes(k)); } });

test('a setup failure records one sync_attention activity row with no account or host in it; a transient one records none', () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  st.setSyncEnabled(u, true);
  const backoff = new Map();
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_UNREACHABLE' }), { now: 1000, backoff });
  assert.equal(listActivity(u, {}).filter((r) => r.kind === 'sync_attention').length, 0);
  recordCycleFailure(u, Object.assign(new Error('x'), { code: 'SYNC_HOST_KEY_CHANGED' }), { now: 2000, backoff });
  const rows = listActivity(u, {}).filter((r) => r.kind === 'sync_attention');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Sync was turned off and needs your attention in Settings');
});
