import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-rotate-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const E = await import('../core/sync-enroll.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { publishOnce } = await import('../routes/sync/producer.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');
const { rotateKeys, previousRoot, PREV_KEY_MS, ensureSyncKeys } = await import('../routes/sync/keys.mjs');
const { rotateNow, rotationPending, withUserLock, syncCycle } = await import('../routes/sync/scheduler.mjs');
const { drainOnce } = await import('../routes/sync/consumer.mjs');
const vault = await import('../server/vault.mjs');

const T = 1_762_400_000_000;
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sr-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' }).id;
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
const noTurn = { phoneChatId: async () => 'c', cancel: () => {}, turn: async () => { throw new Error('no turn may run'); } };
beforeEach(() => _resetEnrollmentsForTest());

test('rotateKeys: epoch + 1, new root, previous root kept 24 h, never a client-visible vault key', () => {
  const { u } = setup();
  ensureSyncKeys(u);
  const before = st.getSyncState(u).epoch;
  const oldRoot = vault.getSecret(kb.getDb(), u, 'sync.rootKey');
  assert.equal(rotateKeys(u, T), before + 1);
  assert.equal(st.getSyncState(u).epoch, before + 1);
  assert.notEqual(vault.getSecret(kb.getDb(), u, 'sync.rootKey'), oldRoot);
  const prev = previousRoot(u, T + 1);
  assert.equal(prev.epoch, before); assert.equal(prev.root.toString('base64url'), oldRoot);
  assert.equal(previousRoot(u, T + PREV_KEY_MS + 1), null);
  assert.ok(!vault.listSecretKeys(kb.getDb(), u).some((r) => r.secret_key === 'sync.prevRootKey'));
});

test('rotateNow: every device gets a new wrap, a full republish, old blobs deleted; the device follows', async () => {
  const { u, store, sid } = setup();
  const a = await enrolled(u, store, 'A');
  await publishOnce({ userId: u, store, now: T + 10, loadKinds: kinds });
  const oldBlobs = (await store.list(`${sid}/d/${a.pair.dir}/s`)).map((f) => f.name).sort();
  const e0 = a.epoch;
  assert.equal(await rotateNow(u, { store, now: T + 20 }), 'done');
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  await publishOnce({ userId: u, store, now: T + 30, loadKinds: kinds });
  const snap = await a.readSnapshot(store);
  assert.equal(a.epoch, e0 + 1, 'the device unwrapped the new epoch from the manifest hint');
  assert.equal(snap.manifest.epoch, e0 + 1);
  const newBlobs = (await store.list(`${sid}/d/${a.pair.dir}/s`)).map((f) => f.name);
  assert.ok(newBlobs.every((x) => !oldBlobs.includes(x)), 'old-epoch blobs are gone');
});

test('a busy lock makes rotation pending; the next cycle runs it', async () => {
  const { u, store } = setup();
  await enrolled(u, store);
  const e0 = st.getSyncState(u).epoch;
  let release;
  const held = withUserLock(u, () => new Promise((r) => { release = r; }));
  assert.equal(await rotateNow(u, { store, now: T }), 'pending');
  assert.equal(rotationPending(u), true);
  release(); await held;
  await syncCycle(u, { now: T + 5, produce: false, store });
  assert.equal(st.getSyncState(u).epoch, e0 + 1);
  assert.equal(rotationPending(u), false);
});

test('an old-epoch request within 24 h gets stale_epoch under the old reply key; after 24 h it is refused', async () => {
  const { u, store, sid } = setup();
  const dev = await enrolled(u, store);
  const oldEpoch = dev.epoch; const oldRequest = dev.wrapKeys.request;
  await rotateNow(u, { store, now: T + 10 });
  const id = await dev.sendRequest(store, 'hello', { now: T + 20, epoch: oldEpoch, key: oldRequest });
  const out = await drainOnce({ userId: u, store, now: T + 30, deps: noTurn });
  assert.equal(out.ran, 0);
  assert.deepEqual(await dev.readReply(store, id), { v: 1, requestId: id, ok: false, code: 'stale_epoch' });
  const again = await dev.sendRequest(store, 'late', { now: T + PREV_KEY_MS + 20, epoch: oldEpoch, key: oldRequest });
  const late = await drainOnce({ userId: u, store, now: T + PREV_KEY_MS + 30, deps: noTurn });
  assert.equal(late.refused, 1);
  assert.equal(await store.get(`${sid}/d/${dev.pair.dir}/out/${again}.bin`), null);
});
