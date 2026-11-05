// Malicious-storage tests: no value read from the store enters a trust decision. Every case must leave the registry empty
// unless it explicitly confirms the pinned claim.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-enroll-malicious-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const E = await import('../core/sync-enroll.mjs');
const S = await import('../core/sync-envelope.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, cancelEnrollment, ENROLL, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');
const { createTamperStore } = await import('./helpers/tamper-store.mjs');

const T = 1_762_400_000_000;
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `sm-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'm' }).id;
function setup() {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  return { u, store: createTamperStore(), sid: st.getSyncState(u).syncId };
}
const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' });
const J = (b) => JSON.parse(Buffer.from(b).toString('utf8'));
const B = (o) => Buffer.from(JSON.stringify(o));
function attackerClaim(qr, { tier = 'ios', name = 'My iPhone' } = {}) {
  const pair = E.parsePair(qr);
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return B(E.sealClaim({ pair, tier, name, ecdhSpki: spki(ecdh), signingSpki: spki(sig), signingKey: sig.privateKey, issuedAt: T }));
}
const registryEmpty = (u) => assert.equal(st.listSyncDevices(u).length, 0, 'nothing enters the registry');
beforeEach(() => _resetEnrollmentsForTest());

test('storage swaps key.bin for its own key: the device refuses before claiming', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const evil = spki(generateKeyPairSync('ec', { namedCurve: 'prime256v1' }));
  store.onGet = (p, b) => (p.endsWith('/key.bin') ? evil : b);
  const dev = createReferenceDevice();
  await assert.rejects(dev.scanAndClaim(store, qr, { now: T }), (e) => e.code === 'bad_desktop_key');
  assert.deepEqual(await store.list(`${sid}/e/${E.parsePair(qr).slot}`), [], 'no claim was written');
  registryEmpty(u);
});

test('storage forges a claim without es: claim_invalid, slot and folder removed', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  const guessed = qr.replace(`es=${pair.es}`, `es=${E.newId22()}`);
  await store.put(`${sid}/e/${pair.slot}/${E.newId22()}.bin`, attackerClaim(guessed));
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'failed'); assert.equal(p.code, 'claim_invalid'); assert.equal(p.sas, null);
  assert.deepEqual(await store.list(`${sid}/d/${pair.dir}`), []);
  registryEmpty(u);
});

test('storage replays a valid claim from an earlier enrollment into a new slot: claim_invalid', async () => {
  const { u, store, sid } = setup();
  const first = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, first.qr, { now: T });
  const old = await store.inner.get(`${sid}/e/${E.parsePair(first.qr).slot}/${dev.claimName}.bin`);
  await cancelEnrollment(u);
  const second = await startEnrollment(u, { store, tier: 'ios', now: T });
  await store.put(`${sid}/e/${E.parsePair(second.qr).slot}/${dev.claimName}.bin`, old);
  assert.equal((await pollEnrollment(u, { now: T + 1000 })).code, 'claim_invalid');
  registryEmpty(u);
});

test('QR photographer with storage control swaps the real claim: the real device never shows a code', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, qr, { now: T });
  await store.inner.remove(`${sid}/e/${pair.slot}/${dev.claimName}.bin`);
  await store.put(`${sid}/e/${pair.slot}/${E.newId22()}.bin`, attackerClaim(qr));
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'confirm', 'the desktop pins the only claim it sees');
  await assert.rejects(dev.readAck(store), (e) => e.code === 'bad_to' || e.code === 'ack_mismatch', 'the ack is bound to the pinned claim, not the phone');
  const ack = J(await store.inner.get(`${sid}/e/${pair.slot}/ack.bin`));
  const keys = E.enrollKeys(Buffer.from(pair.es, 'base64url'), pair.sid, pair.slot);
  const [nD] = S.decodeEnc(S.open({ env: ack, key: keys.enrollack, verifyKey: E.p256Spki(await store.inner.get(`${sid}/d/${pair.dir}/key.bin`)) }), 2);
  const phoneSas = E.sasCode(keys.sas, { ...pair, tier: 'ios', deviceId: dev.deviceId, ecdhSpki: dev.ecdhSpki, signingSpki: dev.signingSpki, name: dev.name, nD });
  assert.notEqual(phoneSas, p.sas);
  await cancelEnrollment(u);
  registryEmpty(u);
});

test('a second claim (race) kills the slot before and after the pin', async () => {
  for (const when of ['before', 'after']) {
    const { u, store, sid } = setup();
    const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
    const pair = E.parsePair(qr);
    const dev = createReferenceDevice();
    await dev.scanAndClaim(store, qr, { now: T });
    if (when === 'after') assert.equal((await pollEnrollment(u, { now: T + 500 })).phase, 'confirm');
    await store.put(`${sid}/e/${pair.slot}/${E.newId22()}.bin`, attackerClaim(qr));
    if (when === 'after') await assert.rejects(confirmEnrollment(u, { now: T + 1000 }), (e) => e.code === 'ENROLL_FAILED');
    const p = await pollEnrollment(u, { now: T + 1000 });
    assert.equal(p.code, 'contested', when);
    registryEmpty(u);
  }
});

test('storage rewrites the claim after the pin: confirm registers the pinned keys and never re-reads the claim', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, qr, { now: T });
  const claimPath = `${sid}/e/${pair.slot}/${dev.claimName}.bin`;
  await pollEnrollment(u, { now: T + 500 });
  const evil = attackerClaim(qr);
  store.onGet = (p, b) => (p === claimPath ? evil : b);
  await confirmEnrollment(u, { now: T + 1000 });
  assert.equal(store.gets.get(claimPath), 1, 'the claim was fetched exactly once');
  const [row] = st.listSyncDevices(u);
  assert.ok(row.signingSpki.equals(dev.signingSpki) && row.ecdhSpki.equals(dev.ecdhSpki));
});

test('storage forges or replays ack.bin: the device refuses', async () => {
  const { u, store, sid } = setup();
  const first = await startEnrollment(u, { store, tier: 'ios', now: T });
  const a = createReferenceDevice();
  await a.scanAndClaim(store, first.qr, { now: T });
  await pollEnrollment(u, { now: T + 500 });
  const oldAck = await store.inner.get(`${sid}/e/${E.parsePair(first.qr).slot}/ack.bin`);
  await cancelEnrollment(u);
  const second = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(second.qr);
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, second.qr, { now: T });
  await store.put(`${sid}/e/${pair.slot}/ack.bin`, oldAck);
  await assert.rejects(dev.readAck(store), (e) => e instanceof S.SyncCryptoError);
  const evilSig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keys = E.enrollKeys(Buffer.from(pair.es, 'base64url'), pair.sid, pair.slot);
  const forged = E.sealAck({ userId: 'x', pair, tier: 'ios', claim: { deviceId: dev.deviceId, ecdhSpki: dev.ecdhSpki, signingSpki: dev.signingSpki, name: dev.name },
    nD: Buffer.alloc(16, 1), keys, signingKey: evilSig.privateKey, seq: 1, issuedAt: T });
  await store.put(`${sid}/e/${pair.slot}/ack.bin`, B(forged));
  await assert.rejects(dev.readAck(store), (e) => e.code === 'bad_signature');
  await cancelEnrollment(u);
  registryEmpty(u);
});

test('storage swaps wrap.bin (forged, or another device\'s): the device takes no keys', async () => {
  const { u, store, sid } = setup();
  const enroll = async (name) => {
    const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
    const dev = createReferenceDevice({ name });
    await dev.scanAndClaim(store, qr, { now: T });
    await pollEnrollment(u, { now: T + 500 });
    await dev.readAck(store);
    await confirmEnrollment(u, { now: T + 1000 });
    return dev;
  };
  const a = await enroll('A');
  const b = await enroll('B');
  const aWrap = await store.inner.get(`${sid}/d/${a.pair.dir}/wrap.bin`);
  store.onGet = (p, x) => (p === `${sid}/d/${b.pair.dir}/wrap.bin` ? aWrap : x);
  await assert.rejects(b.readWrap(store), (e) => e instanceof S.SyncCryptoError, "A's wrap is not for B");
  const evilSig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const real = J(await store.inner.get(`${sid}/d/${b.pair.dir}/wrap.bin`));
  const forged = S.makeSyncWrap({ ids: { userId: real.userId, desktopId: sid, deviceId: b.deviceId }, epoch: real.epoch + 5, tier: 'ios', deviceEcdhSpki: b.ecdhSpki,
    desktopSigningSpki: b.desktop.spki, keys: { request: Buffer.alloc(32), reply: Buffer.alloc(32), snapshot: Buffer.alloc(32), manifest: Buffer.alloc(32) },
    signingKey: evilSig.privateKey, seq: 1, issuedAt: T });
  store.onGet = (p, x) => (p === `${sid}/d/${b.pair.dir}/wrap.bin` ? B(forged) : x);
  await assert.rejects(b.readWrap(store), (e) => e.code === 'bad_signature');
  assert.equal(b.wrapKeys, null);
});

test('tier is the desktop\'s: a browser answering an iPhone slot is refused; storage cannot edit the ack tier', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice({ tier: 'web' });
  await dev.scanAndClaim(store, qr, { now: T });
  assert.equal((await pollEnrollment(u, { now: T + 500 })).code, 'claim_invalid');
  registryEmpty(u);
  const second = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(second.qr);
  const ok = createReferenceDevice({ tier: 'ios' });
  await ok.scanAndClaim(store, second.qr, { now: T });
  await pollEnrollment(u, { now: T + 500 });
  const ack = J(await store.inner.get(`${sid}/e/${pair.slot}/ack.bin`));
  store.onGet = (p, x) => (p.endsWith('/ack.bin') ? B({ ...ack, tier: 'web' }) : x);
  await assert.rejects(ok.readAck(store), (e) => e instanceof S.SyncCryptoError);
  await cancelEnrollment(u);
  registryEmpty(u);
});

test('storage hides the claim until the window closes: expired, nothing registered', async () => {
  const { u, store } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  store.onList = (dir, l) => (dir.includes('/e/') ? [] : l);
  await createReferenceDevice().scanAndClaim(store, qr, { now: T });
  assert.equal((await pollEnrollment(u, { now: T + ENROLL.claimMs + 1 })).phase, 'expired');
  registryEmpty(u);
});
