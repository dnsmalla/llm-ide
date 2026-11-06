// Box connect (SP6 D1): start returns the authorize URL, the public callback trades the code and stores the refresh
// token in the vault, poll reports the outcome once. A storage-kind switch forgets devices, rotates keys and deletes the
// old <syncId>/ tree (D5, D6). No response carries the client secret or a token.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_HOST_APPROVAL_KEY = 'c'.repeat(64);
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-routes-box-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const st = await import('../kb/sync-state.mjs');
const { handleSyncRoute } = await import('../routes/sync/http-routes.mjs');
const { _resetBoxConnectsForTest } = await import('../routes/sync/box-connect.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { createFakeBox } = await import('./helpers/fake-box.mjs');
const { busHostProof } = await import('../core/host-approval.mjs');
const PROOF = busHostProof();

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sb-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
async function call(method, url, { userId, body, proof = true, deps } = {}) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, user: userId ? { id: userId } : undefined, headers: proof ? { 'x-llmide-host-nonce': PROOF } : {},
    socket: { remoteAddress: '127.0.0.1' }, pause() {}, resume() {},
    on(event, cb) { if (event === 'data') chunks.forEach((c) => cb(c)); else if (event === 'end') cb(); return req; } };
  let status = 0; let payload = '';
  const res = { headersSent: false, writeHead(s) { status = s; this.headersSent = true; }, setHeader() {}, end(b) { payload = b ?? ''; } };
  await handleSyncRoute(req, res, deps ? { deps } : {});
  let parsed = null; try { parsed = JSON.parse(payload); } catch { parsed = payload; }
  return { status, body: parsed, raw: String(payload) };
}
beforeEach(() => _resetBoxConnectsForTest());

async function connect(u, fake, deps) {
  const start = await call('POST', '/kb/sync/box/start', { userId: u, body: { clientId: fake.clientId, clientSecret: fake.clientSecret }, deps });
  assert.equal(start.status, 200);
  const url = new URL(start.body.authorizeUrl);
  const back = await call('GET', `/kb/sync/box/callback?code=${fake.issueCode()}&state=${url.searchParams.get('state')}`, { proof: false, deps });
  return { start, url, back };
}

test('start validates, never echoes the secret, and builds a loopback PKCE authorize URL', async () => {
  const u = user(); const fake = createFakeBox();
  const bad = await call('POST', '/kb/sync/box/start', { userId: u, body: { clientId: 'x', clientSecret: fake.clientSecret } });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.field, 'clientId');
  const noProof = await call('POST', '/kb/sync/box/start', { userId: u, proof: false, body: {} });
  assert.equal(noProof.status, 403);
  const { start, url } = await connect(u, fake, { fetchImpl: fake.fetch });
  assert.ok(!start.raw.includes(fake.clientSecret));
  assert.equal(url.origin + url.pathname, 'https://account.box.com/api/oauth2/authorize');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3456/kb/sync/box/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('client_id'), fake.clientId);
});

test('callback stores the secret and refresh token in the vault; status and poll show Box; nothing leaks', async () => {
  const u = user(); const fake = createFakeBox();
  const { back } = await connect(u, fake, { fetchImpl: fake.fetch });
  assert.equal(back.status, 200);
  assert.match(back.raw, /Box is connected/);
  const db = kb.getDb();
  assert.equal(vault.getSecret(db, u, 'sync.boxClientSecret'), fake.clientSecret);
  assert.ok(vault.getSecret(db, u, 'sync.boxRefreshToken'));
  assert.deepEqual(st.getSyncState(u).storeConfig, { clientId: fake.clientId, folder: 'llmide-sync', account: 's***@example.com' });
  const poll = await call('POST', '/kb/sync/box/poll', { userId: u, body: {} });
  assert.deepEqual(poll.body, { phase: 'done', code: null });
  assert.deepEqual((await call('POST', '/kb/sync/box/poll', { userId: u, body: {} })).body, { phase: 'none', code: null }, 'read once');
  const status = await call('GET', '/kb/sync/status', { userId: u });
  assert.equal(status.body.storeKind, 'box');
  assert.deepEqual(status.body.store, { folder: 'llmide-sync', account: 's***@example.com' });
  for (const r of [back.raw, poll.raw, status.raw]) {
    assert.ok(!r.includes(fake.clientSecret)); assert.ok(!r.includes(vault.getSecret(db, u, 'sync.boxRefreshToken')));
  }
});

test('an unknown or reused state, a cancel and a wrong secret never store anything', async () => {
  const u = user(); const fake = createFakeBox();
  const stale = await call('GET', `/kb/sync/box/callback?code=${fake.issueCode()}&state=nope`, { proof: false, deps: { fetchImpl: fake.fetch } });
  assert.match(stale.raw, /expired/);
  const start = await call('POST', '/kb/sync/box/start', { userId: u, body: { clientId: fake.clientId, clientSecret: fake.clientSecret } });
  const state = new URL(start.body.authorizeUrl).searchParams.get('state');
  const cancel = await call('GET', `/kb/sync/box/callback?error=access_denied&state=${state}`, { proof: false, deps: { fetchImpl: fake.fetch } });
  assert.match(cancel.raw, /cancelled/);
  assert.deepEqual((await call('POST', '/kb/sync/box/poll', { userId: u, body: {} })).body, { phase: 'failed', code: 'cancelled' });
  const wrong = await call('POST', '/kb/sync/box/start', { userId: u, body: { clientId: fake.clientId, clientSecret: 'w'.repeat(32) } });
  const s2 = new URL(wrong.body.authorizeUrl).searchParams.get('state');
  const failed = await call('GET', `/kb/sync/box/callback?code=${fake.issueCode()}&state=${s2}`, { proof: false, deps: { fetchImpl: fake.fetch } });
  assert.ok(!failed.raw.includes('invalid_client') && !failed.raw.includes('w'.repeat(32)), 'Box error text is not echoed');
  assert.deepEqual((await call('POST', '/kb/sync/box/poll', { userId: u, body: {} })).body, { phase: 'failed', code: 'SYNC_BAD_CLIENT' });
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.boxRefreshToken'), null);
  assert.equal(st.getSyncState(u), null);
});

test('switching MEGA -> Box forgets devices, rotates keys and deletes the old <syncId>/ tree', async () => {
  const u = user(); const fake = createFakeBox();
  st.ensureSyncState(u, { storeKind: 'mega', storeConfig: { folder: 'llmide-sync' } });
  const { syncId, epoch } = st.getSyncState(u);
  st.addSyncDevice(u, { deviceId: 'sw-dev-1', dir: 'F'.repeat(22), tier: 'web', name: 'B', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  const old = createMemoryStore();
  await old.put(`${syncId}/d/${'F'.repeat(22)}/key.bin`, Buffer.from('k'));
  await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => old });
  assert.deepEqual(st.listSyncDevices(u), []);
  assert.equal(st.getSyncState(u).epoch, epoch + 1);
  assert.equal(st.getSyncState(u).syncId, syncId, 'the sync id stays');
  assert.equal(old.dump().size, 0);
});

test('reconnecting the same Box location keeps devices (no switch)', async () => {
  const u = user(); const fake = createFakeBox();
  await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => null });
  st.addSyncDevice(u, { deviceId: 'same-dev-1', dir: 'G'.repeat(22), tier: 'ios', name: 'P', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => null });
  assert.equal(st.listSyncDevices(u).length, 1);
});

test('moving within Box (another folder) resets publish and keeps devices; the same location resets nothing', async () => {
  const u = user(); const fake = createFakeBox();
  await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => null });
  st.addSyncDevice(u, { deviceId: 'mv-dev-1', dir: 'H'.repeat(22), tier: 'web', name: 'M', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });
  st.setDeviceWrapEpoch(u, 'mv-dev-1', 3);
  await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => null });
  assert.equal(st.listSyncDevices(u)[0].wrapEpoch, 3, 'the same location keeps the publish records');
  const start = await call('POST', '/kb/sync/box/start', { userId: u, body: { clientId: fake.clientId, clientSecret: fake.clientSecret, folder: 'other-folder' }, deps: { fetchImpl: fake.fetch } });
  const state = new URL(start.body.authorizeUrl).searchParams.get('state');
  await call('GET', `/kb/sync/box/callback?code=${fake.issueCode()}&state=${state}`, { proof: false, deps: { fetchImpl: fake.fetch, storeFor: () => null } });
  assert.equal(st.getSyncState(u).storeConfig.folder, 'other-folder');
  assert.equal(st.listSyncDevices(u)[0].wrapEpoch, 0, 'a move resets the publish records');
  assert.equal(st.listSyncDevices(u).length, 1, 'devices stay within one kind');
});

test('an unavailable user lock ends the connect as failed SYNC_BUSY and changes nothing', async () => {
  const u = user(); const fake = createFakeBox();
  const { withUserLock } = await import('../routes/sync/scheduler.mjs');
  let release;
  const held = new Promise((r) => { release = r; });
  const holder = withUserLock(u, () => held);
  try {
    const { back } = await connect(u, fake, { fetchImpl: fake.fetch });
    assert.ok(!back.raw.includes('Box is connected'));
  } finally {
    release();
    await holder;
  }
  assert.deepEqual((await call('POST', '/kb/sync/box/poll', { userId: u, body: {} })).body, { phase: 'failed', code: 'SYNC_BUSY' });
  assert.equal(st.getSyncState(u), null);
  assert.equal(vault.getSecret(kb.getDb(), u, 'sync.boxRefreshToken'), null);
});

const KEYS = ['sync.megaEmail', 'sync.megaPassword', 'sync.sshKey', 'sync.boxClientSecret', 'sync.boxRefreshToken'];
const SFTP = { host: 'sync.example.com', hostFingerprint: '256 SHA256:iNnnGvKXwwL9PllrTyYK6feetKxNfZbbuvlUdZSnbtM root@vps (ED25519)' };
const MEGA = { email: 'llmide-sync@example.com', password: 'a long dedicated password' };
const secrets = (u) => Object.fromEntries(KEYS.map((k) => [k, vault.getSecret(kb.getDb(), u, k)]));
const addDevice = (u, id) => st.addSyncDevice(u, { deviceId: id, dir: 'K'.repeat(22), tier: 'ios', name: 'P', ecdhSpki: Buffer.from([1]), signingSpki: Buffer.from([2]), now: 1 });

for (const [kind, setup] of [
  ['mega', (u) => call('POST', '/kb/sync/mega', { userId: u, body: MEGA })],
  ['sftp', (u) => call('POST', '/kb/sync/sftp', { userId: u, body: SFTP })],
]) {
  test(`switching ${kind} -> Box unlinks devices, keeps only the Box secrets and rotates keys`, async () => {
    const u = user(); const fake = createFakeBox();
    await setup(u);
    const { epoch } = st.getSyncState(u);
    addDevice(u, `${kind}-box-1`);
    await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => null });
    assert.deepEqual(st.listSyncDevices(u), []);
    assert.equal(st.getSyncState(u).epoch, epoch + 1);
    const s = secrets(u);
    assert.equal(s['sync.boxClientSecret'], fake.clientSecret);
    assert.ok(s['sync.boxRefreshToken']);
    for (const k of ['sync.megaEmail', 'sync.megaPassword', 'sync.sshKey']) assert.equal(s[k], null, k);
  });

  test(`switching Box -> ${kind} unlinks devices and clears both Box secrets`, async () => {
    const u = user(); const fake = createFakeBox();
    await connect(u, fake, { fetchImpl: fake.fetch, storeFor: () => null });
    addDevice(u, `box-${kind}-1`);
    const r = await setup(u);
    assert.equal(r.status, 200);
    assert.equal(r.body.storeKind, kind);
    assert.deepEqual(r.body.devices, []);
    const s = secrets(u);
    assert.equal(s['sync.boxClientSecret'], null);
    assert.equal(s['sync.boxRefreshToken'], null);
  });
}
