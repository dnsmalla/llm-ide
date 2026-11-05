// The browser device runs the sync v1 device contract against a desktop made of the shipped Node core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../extension/connectors/sync-store/index.mjs';
import { createFakeDesktop } from './helpers/fake-desktop.mjs';
import { parsePair, ID22 } from '../src/sync/enroll.ts';
import { startPairing, readAck, readFirstWrap, readSnapshot, sendRequest, readReply, MAX_TEXT, PREV_REPLY_MS } from '../src/sync/device.ts';

const T = 1_762_400_000_000;
const MARK = 'SECRET-MARKER-7f3a';
const kinds = (tag = 'a') => ({
  chats: { items: [{ id: 'c1', title: `Chat ${tag} ${MARK}`, updatedAt: T, messages: [{ seq: 1, role: 'user', content: `hi ${MARK}` }] }] },
  meetings: { items: [{ id: 'm1', title: 'Standup', date: '2026-11-05', durationSec: 900, participants: ['Ana'], notes: [{ kind: 'decision', text: 'Ship it' }] }] },
  plans: { items: [{ id: 'p1', title: 'Launch', goal: 'Go', updatedAt: T, tasks: [{ title: 'Write docs', status: 'open', owner: 'Dee', due: null, milestone: '', risk: '' }] }] },
  usage: { items: [{ providers: [] }] },
});
const counting = (inner) => { const gets = []; return { gets, get: (p) => { gets.push(p); return inner.get(p); }, put: (p, b, m) => inner.put(p, b, m) }; };

async function linked(store = createMemoryStore()) {
  const desk = createFakeDesktop({ store });
  const pair = parsePair(await desk.open(T));
  const e = await startPairing(store, pair, { name: `Laptop ${MARK}`, now: T });
  assert.equal(await readAck(store, e), null, 'no ack before the desktop pinned the claim');
  const deskSas = await desk.take(T + 1000);
  assert.match(deskSas, /^[0-9]{6}$/);
  assert.equal(await readAck(store, e), deskSas, 'both screens show the same code');
  assert.equal(await readFirstWrap(store, e, { megaEmail: 'sync@example.com' }), null, 'no wrap before "Codes match"');
  const dev = await desk.confirm(T + 2000);
  const d = await readFirstWrap(store, e, { megaEmail: 'sync@example.com' });
  return { store, desk, dev, d, e, pair };
}

test('pairing: one claim under a fresh name, same SAS, a linked record with non-extractable keys', async () => {
  const { store, dev, d, e, pair } = await linked();
  assert.match(e.claimPath, new RegExp(`^${pair.sid}/e/${pair.slot}/[A-Za-z0-9_-]{22}\\.bin$`));
  assert.equal(e.pair.es, '', 'the enrollment secret string is dropped once its keys are derived');
  assert.equal(d.deviceId, dev.deviceId); assert.match(d.deviceId, ID22);
  assert.equal(d.tier, 'web'); assert.equal(d.epoch, 1); assert.equal(d.userId, 'user-AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(d.manifestSeq, 0); assert.deepEqual(d.pending, []);
  for (const k of [d.ecdhPrivate, d.signingPrivate, ...Object.values(d.keys)]) assert.equal(k.extractable, false);
  assert.equal(await readSnapshot(store, d, T + 3000), null, 'linked, but the desktop has not published yet');
});

test('a retried claim reuses the same bytes; a wrong key.bin stops before anything is written', async () => {
  const store = createMemoryStore();
  const desk = createFakeDesktop({ store });
  const pair = parsePair(await desk.open(T));
  const e = await startPairing(store, pair, { name: 'B', now: T });
  await store.put(e.claimPath, e.claimBytes, 1);
  assert.equal((await store.list(`${pair.sid}/e/${pair.slot}`)).length, 1);
  const other = createFakeDesktop({ store });
  const pair2 = { ...parsePair(await other.open(T)), sfp: pair.sfp };
  await assert.rejects(startPairing(store, pair2, { name: 'B', now: T }), (err) => err.code === 'bad_desktop_key');
  assert.deepEqual(await store.list(`${pair2.sid}/e/${pair2.slot}`), []);
});

test('snapshot: manifest then blobs by SHA-256; kinds verified; unchanged blobs are not downloaded again', async () => {
  const { store, desk, dev, d } = await linked();
  const m = await desk.publish(dev, kinds(), T + 3000);
  const cache = new Map();
  const c = counting(store);
  const s = await readSnapshot(c, d, T + 3000, cache);
  assert.equal(s.manifestSeq, m.manifestSeq); assert.equal(d.manifestSeq, m.manifestSeq);
  assert.equal(s.validUntil, T + 3000 + 45 * 60_000);
  assert.deepEqual(Object.keys(s.kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  assert.equal(s.kinds.chats.items[0].messages[0].content, `hi ${MARK}`);
  assert.equal(s.kinds.meetings.items[0].notes[0].text, 'Ship it');
  assert.equal(s.kinds.plans.items[0].tasks[0].title, 'Write docs');
  assert.equal(c.gets.length, 5, 'manifest + 4 blobs');
  c.gets.length = 0;
  await readSnapshot(c, d, T + 4000, cache);
  assert.deepEqual(c.gets.map((p) => p.split('/').at(-1)), ['manifest.bin'], 'the cache serves verified blobs');
});

test('a blob gone mid-publish is "updating"; a deleted device folder is "removed"', async () => {
  const { store, desk, dev, d } = await linked();
  const m = await desk.publish(dev, kinds(), T + 3000);
  await store.remove(`${d.sid}/d/${d.dir}/${m.kinds.plans.file}`);
  await assert.rejects(readSnapshot(store, d, T + 3000), (e) => e.code === 'updating');
  assert.equal(d.manifestSeq, 0, 'a failed read commits nothing');
  await store.removeTree(`${d.sid}/d/${d.dir}`);
  await assert.rejects(readSnapshot(store, d, T + 3000), (e) => e.code === 'removed');
});

test('a queued prompt is a closed chat.send request in the inbox; the reply comes back once', async () => {
  const { store, desk, dev, d } = await linked();
  const id = await sendRequest(store, d, `what changed? ${MARK}`, T + 5000);
  assert.match(id, ID22);
  assert.deepEqual(d.pending, [{ requestId: id, issuedAt: T + 5000 }]);
  const [req] = await desk.drain(dev, undefined, T + 6000);
  assert.equal(req.name, `${String(T + 5000).padStart(13, '0')}-${id}.bin`);
  assert.deepEqual(Object.keys(req).filter((k) => !['name', 'header'].includes(k)).sort(), ['class', 'requestId', 'text', 'v']);
  assert.equal(req.class, 'chat.send'); assert.equal(req.text, `what changed? ${MARK}`);
  assert.equal(req.header.issuedAt, T + 5000); assert.equal(req.header.epoch, 1);
  assert.deepEqual(await readReply(store, d, id, T + 7000), { v: 1, requestId: id, ok: true, text: `echo: what changed? ${MARK}`, finishedAt: T + 6000 });
  assert.deepEqual(d.pending, []);
  assert.equal(await readReply(store, d, 'AAAAAAAAAAAAAAAAAAAAAA', T), null);
  for (const bad of ['', 'x'.repeat(MAX_TEXT + 1)]) await assert.rejects(sendRequest(store, d, bad, T), (e) => e.code === 'bad_text');
});

test('rotation: a newer wrap is taken when the manifest moves; an old-epoch request is answered stale_epoch', async () => {
  const { store, desk, dev, d } = await linked();
  await desk.publish(dev, kinds(), T + 3000);
  await readSnapshot(store, d, T + 3000);
  const id = await sendRequest(store, d, 'before rotation', T + 3500);
  await desk.rotate(T + 4000);
  await desk.publish(dev, kinds('b'), T + 4000);
  const [req] = await desk.drain(dev, undefined, T + 4500);
  assert.equal(req.header.epoch, 1);
  const s = await readSnapshot(store, d, T + 5000);
  assert.equal(d.epoch, 2);
  assert.equal(d.prevReply.epoch, 1);
  assert.match(s.kinds.chats.items[0].title, /^Chat b/);
  assert.deepEqual(await readReply(store, d, id, T + 5000), { v: 1, requestId: id, ok: false, code: 'stale_epoch' });
  const again = await sendRequest(store, d, 'after rotation', T + 6000);
  await desk.drain(dev, undefined, T + 6500);
  assert.equal((await readReply(store, d, again, T + 7000)).ok, true);
});

test("the previous epoch's reply key is honoured for 24 hours only", async () => {
  const { store, desk, dev, d } = await linked();
  const id = await sendRequest(store, d, 'late', T + 3000);
  await desk.rotate(T + 3000);
  await desk.publish(dev, kinds(), T + 3000);
  await readSnapshot(store, d, T + 3000);
  await desk.drain(dev, undefined, T + 3100);
  await assert.rejects(readReply(store, d, id, T + 3000 + PREV_REPLY_MS + 1), (e) => e.code === 'bad_epoch');
});

test('nothing in storage is plaintext: no device name, prompt or snapshot text in any stored byte', async () => {
  const { store, desk, dev, d } = await linked();
  await desk.publish(dev, kinds(), T + 3000);
  await readSnapshot(store, d, T + 3000);
  await sendRequest(store, d, `prompt ${MARK}`, T + 4000);
  const needle = Buffer.from(MARK);
  for (const [path, bytes] of store.dump()) {
    assert.ok(!Buffer.from(bytes).includes(needle), `plaintext marker in ${path}`);
    assert.ok(!Buffer.from(bytes).includes(Buffer.from('sync@example.com')), `MEGA email in ${path}`);
  }
});
