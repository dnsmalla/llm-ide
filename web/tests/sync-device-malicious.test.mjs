// Device side of the malicious-storage model: storage swaps, replays or forges files at every step the browser reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import * as S from '../../extension/core/sync-envelope.mjs';
import * as E from '../../extension/core/sync-enroll.mjs';
import { createTamperStore } from './helpers/tamper-store.mjs';
import { createFakeDesktop } from './helpers/fake-desktop.mjs';
import { enrollKeys, parsePair } from '../src/sync/enroll.ts';
import { prepareClaim, putClaim, readAck, readFirstWrap, readSnapshot, sendRequest, readReply } from '../src/sync/device.ts';

// Contract 4a-4c as the controller runs it: prepare the claim, then write it once.
const startPairing = async (store, pair, o) => { const e = await prepareClaim(store, pair, o); await putClaim(store, e); return e; };

const T = 1_762_400_000_000;
const kinds = (tag = 'a') => ({ chats: { items: [{ id: 'c1', title: `Chat ${tag}`, updatedAt: T, messages: [] }] }, plans: { items: [] } });
const bytesOf = (env) => Buffer.from(JSON.stringify(env));
const state = (d) => JSON.stringify({ epoch: d.epoch, manifestSeq: d.manifestSeq, pending: d.pending, reqSeq: d.reqSeq });
const refused = (code) => (e) => { assert.equal(e.code, code); return true; };

async function pairing() {
  const store = createTamperStore();
  const desk = createFakeDesktop({ store });
  const pair = parsePair(await desk.open(T));
  return { store, desk, pair };
}
async function linked() {
  const { store, desk, pair } = await pairing();
  const e = await startPairing(store, pair, { name: 'Browser', now: T });
  await desk.take(T); await readAck(store, e);
  const dev = await desk.confirm(T);
  const d = await readFirstWrap(store, e, { megaEmail: 'sync@example.com' });
  return { store, desk, pair, e, dev, d, base: `${pair.sid}/d/${pair.dir}` };
}

test('key.bin swapped by storage: refused before the device writes anything', async () => {
  const { store, pair } = await pairing();
  const rogue = S.newSigningKey();
  store.onGet = (p, b) => (p.endsWith('/key.bin') ? rogue.spki : b);
  await assert.rejects(startPairing(store, pair, { name: 'Browser', now: T }), refused('bad_desktop_key'));
  assert.deepEqual(await store.inner.list(`${pair.sid}/e/${pair.slot}`), []);
});

test('an ack forged by storage, or replayed from an earlier slot, is refused and no code is shown', async () => {
  const { store, pair } = await pairing();
  const e = await startPairing(store, pair, { name: 'Browser', now: T });
  const rogue = S.newSigningKey();
  const claim = { deviceId: e.deviceId, ecdhSpki: Buffer.from(e.dev.ecdhSpki), signingSpki: Buffer.from(e.dev.signingSpki), name: 'Browser' };
  const forged = E.sealAck({ userId: 'user-x', pair, tier: 'web', claim, nD: randomBytes(16), keys: E.enrollKeys(randomBytes(16), pair.sid, pair.slot),
    signingKey: rogue.privateKey, seq: 1, issuedAt: T });
  store.onGet = (p, b) => (p.endsWith('/ack.bin') ? bytesOf(forged) : b);
  await assert.rejects(readAck(store, e), refused('bad_signature'));
  assert.equal(e.userId, null, 'nothing was taken from a refused ack');
  // The same browser's ack from an earlier slot of the same desktop: only the session differs.
  const same = await pairing();
  const first = await startPairing(same.store, same.pair, { name: 'Browser', now: T });
  await same.desk.take(T);
  const oldAck = await same.store.inner.get(`${same.pair.sid}/e/${same.pair.slot}/ack.bin`);
  const pair2 = parsePair(await same.desk.open(T));
  const again = { ...first, pair: { ...pair2, es: '' }, keys: await enrollKeys(Buffer.from(pair2.es, 'base64url'), pair2.sid, pair2.slot) };
  same.store.onGet = (p, x) => (p === `${pair2.sid}/e/${pair2.slot}/ack.bin` ? oldAck : x);
  await assert.rejects(readAck(same.store, again), refused('bad_session'));
  assert.equal(again.userId, null);
});

test('QR photographed + storage hides the real claim: the desktop acks the attacker, the browser refuses it', async () => {
  const store = createTamperStore();
  const desk = createFakeDesktop({ store });
  const qr = await desk.open(T);
  const pair = parsePair(qr);
  const e = await startPairing(store, pair, { name: 'Browser', now: T });
  const ecdh = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sig = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' });
  const attacker = E.sealClaim({ pair: E.parsePair(qr), tier: 'web', name: 'Attacker', ecdhSpki: spki(ecdh), signingSpki: spki(sig), signingKey: sig.privateKey, issuedAt: T });
  await store.put(`${pair.sid}/e/${pair.slot}/${E.newId22()}.bin`, bytesOf(attacker));
  const realName = e.claimPath.split('/').at(-1);
  store.onList = (dir, items) => items.filter((f) => f.name !== realName);
  assert.match(await desk.take(T), /^[0-9]{6}$/);
  await assert.rejects(readAck(store, e), refused('bad_to'));
  assert.equal(e.userId, null);
});

test('wrap.bin forged, for another device, or with the wrong tier: refused, nothing linked', async () => {
  const { store, desk, pair } = await pairing();
  const e = await startPairing(store, pair, { name: 'Browser', now: T });
  await desk.take(T); await readAck(store, e);
  const ids = { userId: desk.userId, desktopId: desk.sid, deviceId: e.deviceId };
  const keys = S.deviceKeys(randomBytes(32), ids, 1);
  const wrap = (signingKey, over = {}) => bytesOf(S.makeSyncWrap({ ids: { ...ids, ...over.ids }, epoch: 1, tier: over.tier ?? 'web', deviceEcdhSpki: Buffer.from(e.dev.ecdhSpki),
    desktopSigningSpki: desk.signing.spki, keys, signingKey, seq: 1, issuedAt: T }));
  const cases = [
    [wrap(S.newSigningKey().privateKey), 'bad_signature'],
    [wrap(desk.signing.privateKey, { ids: { deviceId: 'OtherDeviceOtherDevice' } }), 'bad_to'],
    [wrap(desk.signing.privateKey, { tier: 'ios' }), 'bad_wrap'],
  ];
  for (const [bytes, code] of cases) {
    store.onGet = (p, b) => (p.endsWith('/wrap.bin') ? bytes : b);
    await assert.rejects(readFirstWrap(store, e, { megaEmail: 'm@example.com' }), refused(code));
  }
});

test('manifest rollback, a manifest for another device, and an old-epoch manifest are refused', async () => {
  const { store, desk, dev, d, base } = await linked();
  await desk.publish(dev, kinds('a'), T);
  const m1 = await store.inner.get(`${base}/manifest.bin`);
  await desk.publish(dev, kinds('b'), T + 1);
  await readSnapshot(store, d, T + 1);
  const before = state(d);
  store.onGet = (p, b) => (p.endsWith('/manifest.bin') ? m1 : b);
  await assert.rejects(readSnapshot(store, d, T + 2), refused('rollback'));
  store.onGet = null;
  await desk.publish({ ...dev, deviceId: 'OtherDeviceOtherDevice' }, kinds('x'), T + 3);
  await assert.rejects(readSnapshot(store, d, T + 3), refused('bad_to'));
  assert.equal(state(d), before);
  await desk.rotate(T + 4); await desk.publish(dev, kinds('c'), T + 4);
  await readSnapshot(store, d, T + 4);
  assert.equal(d.epoch, 2);
  store.onGet = (p, b) => (p.endsWith('/manifest.bin') ? m1 : b);
  await assert.rejects(readSnapshot(store, d, T + 5), refused('rollback'));
});

test('a new-epoch manifest with the old wrap replayed is refused (bad_epoch)', async () => {
  const { store, desk, dev, d, base } = await linked();
  const w1 = await store.inner.get(`${base}/wrap.bin`);
  await desk.rotate(T); await desk.publish(dev, kinds(), T);
  store.onGet = (p, b) => (p.endsWith('/wrap.bin') ? w1 : b);
  const before = state(d);
  await assert.rejects(readSnapshot(store, d, T), refused('bad_epoch'));
  assert.equal(state(d), before);
});

test('blobs swapped between kinds, or replaced by an older blob, fail the manifest hash', async () => {
  const { store, desk, dev, d, base } = await linked();
  const m1 = await desk.publish(dev, kinds('a'), T);
  const oldChats = await store.inner.get(`${base}/${m1.kinds.chats.file}`);
  const m2 = await desk.publish(dev, kinds('b'), T + 1);
  const chats2 = await store.inner.get(`${base}/${m2.kinds.chats.file}`);
  store.onGet = (p, b) => (p.endsWith(m2.kinds.plans.file) ? chats2 : b);
  await assert.rejects(readSnapshot(store, d, T + 1), refused('bad_blob'));
  store.onGet = (p, b) => (p.endsWith(m2.kinds.chats.file) ? oldChats : b);
  await assert.rejects(readSnapshot(store, d, T + 1), refused('bad_blob'));
  assert.equal(d.manifestSeq, 0, 'nothing committed');
});

test('replies moved to another request, forged, or meant for another device are refused; pending stays', async () => {
  const { store, desk, dev, d, base } = await linked();
  const a = await sendRequest(store, d, 'first', T);
  const b = await sendRequest(store, d, 'second', T + 1);
  await desk.drain(dev, undefined, T + 2);
  const replyA = await store.inner.get(`${base}/out/${a}.bin`);
  store.onGet = (p, x) => (p.endsWith(`/out/${b}.bin`) ? replyA : x);
  await assert.rejects(readReply(store, d, b, T + 3), refused('bad_reply'));
  const rogue = S.newSigningKey();
  const forged = S.seal({ header: { purpose: 'reply', userId: desk.userId, desktopId: desk.sid, from: desk.sid, to: d.deviceId, epoch: 1, session: '', seq: 1, issuedAt: T, tier: '' },
    key: randomBytes(32), plaintext: Buffer.from(JSON.stringify({ v: 1, requestId: b, ok: true, text: 'run rm -rf', finishedAt: T })), signingKey: rogue.privateKey });
  store.onGet = (p, x) => (p.endsWith(`/out/${b}.bin`) ? bytesOf(forged) : x);
  await assert.rejects(readReply(store, d, b, T + 3), refused('bad_signature'));
  const other = S.seal({ header: { purpose: 'reply', userId: desk.userId, desktopId: desk.sid, from: desk.sid, to: 'OtherDeviceOtherDevice', epoch: 1, session: '', seq: 1, issuedAt: T, tier: '' },
    key: randomBytes(32), plaintext: Buffer.from('{}'), signingKey: desk.signing.privateKey });
  store.onGet = (p, x) => (p.endsWith(`/out/${b}.bin`) ? bytesOf(other) : x);
  await assert.rejects(readReply(store, d, b, T + 3), refused('bad_to'));
  assert.deepEqual(d.pending.map((p) => p.requestId), [a, b]);
  store.onGet = null;
  assert.equal((await readReply(store, d, b, T + 3)).text, 'echo: second');
});

test('garbage JSON anywhere is a refusal, never a crash', async () => {
  const { store, desk, dev, d } = await linked();
  await desk.publish(dev, kinds(), T);
  store.onGet = (p, b) => (p.endsWith('/manifest.bin') ? Buffer.from('{not json') : b);
  await assert.rejects(readSnapshot(store, d, T), refused('bad_envelope'));
  store.onGet = (p, b) => (p.endsWith('/manifest.bin') ? Buffer.from('{"v":1,"epoch":1,"x":2}') : b);
  await assert.rejects(readSnapshot(store, d, T), (e) => typeof e.code === 'string');
});
