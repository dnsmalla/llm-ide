import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-registry-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { publishOnce } = await import('../routes/sync/producer.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');
const { revokeDevice, pruneMissingDevices } = await import('../routes/sync/registry.mjs');
const { rotateNow } = await import('../routes/sync/scheduler.mjs');
const { drainOnce } = await import('../routes/sync/consumer.mjs');
const { listActivity } = await import('../kb/activity.mjs');

const T = 1_762_400_000_000;
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `srg-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'g' }).id;
const kinds = () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [] }))]));
function setup() {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  return { u, store: createMemoryStore(), sid: st.getSyncState(u).syncId };
}
async function enrolled(u, store, name = 'Phone') {
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice({ name });
  await dev.scanAndClaim(store, qr, { now: T });
  await pollEnrollment(u, { now: T + 1 });
  await dev.readAck(store);
  await confirmEnrollment(u, { now: T + 2 });
  await dev.readWrap(store);
  return dev;
}
const under = (store, prefix) => [...store.dump().keys()].filter((p) => p.startsWith(prefix));
beforeEach(() => _resetEnrollmentsForTest());

test('revoke from Settings: folder gone, row gone, epoch rotated, the other device keeps reading', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  const b = await enrolled(u, store, 'B');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  const e0 = st.getSyncState(u).epoch;
  assert.equal(await revokeDevice(u, a.deviceId, { store }), true);
  await rotateNow(u, { store, now: T + 20 });
  assert.deepEqual(under(store, `${sid}/d/${a.pair.dir}/`), []);
  assert.deepEqual(st.listSyncDevices(u).map((d) => d.name), ['B']);
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  await publishOnce({ userId: u, store, now: T + 30, loadKinds: kinds });
  assert.equal((await b.readSnapshot(store)).manifest.epoch, e0 + 1);
  assert.equal(await revokeDevice(u, a.deviceId, { store }), false, 'unknown device');
});

test('revoked device: a request it plants in a recreated folder is never read', async () => {
  const { u, store } = setup();
  const a = await enrolled(u, store, 'A');
  await revokeDevice(u, a.deviceId, { store });
  await a.sendRequest(store, 'still here?', { now: T + 40 });
  const out = await drainOnce({ userId: u, store, now: T + 50, deps: { phoneChatId: async () => 'c', cancel: () => {}, turn: async () => { throw new Error('no'); } } });
  assert.deepEqual(out, { ran: 0, refused: 0, replied: 0 });
});

test('desktop-off revoke: a deleted folder drops the device, rotates, records a notice, and is never recreated', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'Lost phone');
  const b = await enrolled(u, store, 'B');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  const e0 = st.getSyncState(u).epoch;
  await store.removeTree(`${sid}/d/${a.pair.dir}`);
  await publishOnce({ userId: u, store, now: T + 20, loadKinds: kinds });
  assert.deepEqual(st.listSyncDevices(u).map((d) => d.name), ['B']);
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  assert.deepEqual(under(store, `${sid}/d/${a.pair.dir}/`), [], 'never recreated');
  assert.ok(listActivity(u, {}).some((r) => r.kind === 'sync_device_removed' && r.title.includes('Lost phone')));
  assert.equal((await b.readSnapshot(store)).manifest.epoch, e0 + 1);
});

test('a reset location (wrapEpoch 0, SP1 store change) is republished, not pruned', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  st.resetSyncPublish(u);
  const fresh = createMemoryStore();
  assert.deepEqual(await pruneMissingDevices(u, { store: fresh }), { dropped: [] });
  await publishOnce({ userId: u, store: fresh, now: T + 10, loadKinds: kinds });
  assert.ok(await fresh.get(`${sid}/d/${a.pair.dir}/wrap.bin`));
  assert.equal(st.listSyncDevices(u).length, 1);
});

test('a folder deleted during a turn gets no reply written into it', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  await a.sendRequest(store, 'hi', { now: T + 20 });
  const deps = { phoneChatId: async () => 'c', cancel: () => {},
    turn: async (args) => { await store.removeTree(`${sid}/d/${a.pair.dir}`); args.onEvent({ type: 'delta', text: 'answer' }); } };
  await drainOnce({ userId: u, store, now: T + 30, deps });
  assert.deepEqual(under(store, `${sid}/d/${a.pair.dir}/`), []);
});
