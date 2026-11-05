// A test device decrypts everything it would read: wrap -> manifest -> blobs. The store must hold no plaintext marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-producer-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const S = await import('../core/sync-envelope.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { publishOnce, HEARTBEAT_MS } = await import('../routes/sync/producer.mjs');
const { ensureSyncKeys } = await import('../routes/sync/keys.mjs');

let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sp-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'p' }).id;
const MARK = 'PLAINTEXT-MARKER-7f3a';
const fakeKinds = (extra = '') => () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [MARK + extra] }))]));

function device(u) {
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const d = { deviceId: 'h1-dev-1', dir: 'D'.repeat(22), tier: 'web', name: 'Phone',
    ecdhSpki: ecdh.publicKey.export({ type: 'spki', format: 'der' }), signingSpki: sig.publicKey.export({ type: 'spki', format: 'der' }) };
  st.addSyncDevice(u, { ...d, now: 1 });
  return { ...d, ecdhPrivate: ecdh.privateKey };
}

async function readAs(store, state, u, dev, epoch = 0) {
  const base = `${state.syncId}/d/${dev.dir}`;
  const spki = await store.get(`${base}/key.bin`);
  const verifyKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const keys = S.unwrapSync({ env: JSON.parse(await store.get(`${base}/wrap.bin`)), ecdhPrivate: dev.ecdhPrivate, deviceEcdhSpki: dev.ecdhSpki,
    desktopSigningSpki: spki, verifyKey, currentEpoch: epoch, deviceId: dev.deviceId });
  const manifest = JSON.parse(S.open({ env: JSON.parse(await store.get(`${base}/manifest.bin`)), key: keys.manifest, verifyKey, expect: { purpose: 'manifest', to: dev.deviceId } }));
  const kinds = {};
  for (const [kind, e] of Object.entries(manifest.kinds)) {
    const bytes = await store.get(`${base}/${e.file}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), e.sha256, 'manifest binds the blob');
    kinds[kind] = JSON.parse(S.open({ env: JSON.parse(bytes), key: keys.snapshot, verifyKey, expect: { purpose: 'snapshot', to: dev.deviceId } }));
  }
  return { manifest, kinds, spki };
}

test('publish writes key, wrap, manifest and blobs a device can verify and decrypt; the store sees no plaintext', async () => {
  const u = user();
  const state = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const dev = device(u);
  const store = createMemoryStore();
  const r = await publishOnce({ userId: u, store, now: 10_000, loadKinds: fakeKinds() });
  assert.deepEqual(r, { devices: 1, blobs: 4, manifests: 1 });
  const { manifest, kinds, spki } = await readAs(store, state, u, dev);
  assert.equal(S.spkiFingerprint(spki), ensureSyncKeys(u).fingerprint);
  assert.deepEqual(Object.keys(kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  assert.equal(manifest.validUntil, manifest.generatedAt + 45 * 60_000);
  for (const [, bytes] of store.dump()) assert.ok(!bytes.toString('latin1').includes(MARK), 'blindness');
});

test('an unchanged publish writes nothing until the heartbeat, a change rewrites only that kind, old blobs are removed', async () => {
  const u = user();
  const state = st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  const dev = device(u);
  const store = createMemoryStore();
  await publishOnce({ userId: u, store, now: 10_000, loadKinds: fakeKinds() });
  const first = (await readAs(store, state, u, dev)).manifest;
  assert.deepEqual(await publishOnce({ userId: u, store, now: 20_000, loadKinds: fakeKinds() }), { devices: 1, blobs: 0, manifests: 0 });
  const beat = await publishOnce({ userId: u, store, now: 10_000 + HEARTBEAT_MS, loadKinds: fakeKinds() });
  assert.deepEqual(beat, { devices: 1, blobs: 0, manifests: 1 });
  const changed = () => ({ ...fakeKinds()(), chats: Buffer.from('{"v":1,"kind":"chats","generatedAt":2,"truncated":false,"items":["new"]}') });
  assert.deepEqual(await publishOnce({ userId: u, store, now: 10_000 + HEARTBEAT_MS + 1, loadKinds: changed }), { devices: 1, blobs: 1, manifests: 1 });
  const { manifest, kinds } = await readAs(store, state, u, dev);
  assert.ok(manifest.manifestSeq > first.manifestSeq, 'manifestSeq only grows');
  assert.deepEqual(kinds.chats.items, ['new']);
  const files = (await store.list(`${state.syncId}/d/${dev.dir}/s`)).map((f) => `s/${f.name}`).sort();
  assert.deepEqual(files, Object.values(manifest.kinds).map((k) => k.file).sort(), 'only manifest-named blobs remain');
});

test('disabled sync publishes nothing', async () => {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  device(u);
  const store = createMemoryStore();
  assert.deepEqual(await publishOnce({ userId: u, store, now: 1, loadKinds: fakeKinds() }), { devices: 0, blobs: 0, manifests: 0 });
  assert.equal(store.dump().size, 0);
});
