// The sync tier controller with a fake clock, fake timers and network events, a memory keystore, and the fake desktop
// on a tamper store standing in for MEGA. No React, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncController, POLL_MS, FORGET_SYNC_CONFIRM, TEXT } from '../src/sync/controller.ts';
import { memoryKeyStore } from '../src/sync/keystore.ts';
import { SyncStoreError } from '../src/sync/mega-store.ts';
import { createFakeDesktop } from './helpers/fake-desktop.mjs';
import { createTamperStore } from './helpers/tamper-store.mjs';

const T = 1_762_400_000_000;
const PW = 'Correct-Horse-Battery-77';
const EMAIL = 'sync@example.com';
const flush = () => new Promise((r) => setImmediate(r));
const kinds = (tag = 'a') => ({ chats: { items: [{ id: 'c1', title: `Chat ${tag}`, updatedAt: T, messages: [] }] }, usage: { items: [{ providers: [] }] } });

function rig(st = 'mega:llmide-sync') {
  const store = createTamperStore();
  const desk = createFakeDesktop({ store, st });
  const r = { store, desk, st, clock: T, timers: [], net: [], keystore: memoryKeyStore(), link: null, gets: 0, closed: 0, failOpen: null, dev: null, sasSeen: null };
  r.c = createSyncController({
    keystore: r.keystore, now: () => r.clock,
    sleep: async (ms) => { r.clock += ms; if (!r.desk.lastSas) await r.desk.take(r.clock); else if (!r.dev) r.dev = await r.desk.confirm(r.clock); },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; r.timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.live = false; },
    confirm: (m) => { assert.equal(m, FORGET_SYNC_CONFIRM); return true; },
    online: () => true,
    onNetwork: (fn) => { r.net.push(fn); return () => {}; },
    takePairLink: () => r.link,
    openStore: async ({ st, email, password }) => {
      assert.equal(st, r.st);
      if (r.failOpen) throw r.failOpen;
      if (st.startsWith('mega:') && (email !== EMAIL || password !== PW)) throw new SyncStoreError('SYNC_AUTH_FAILED');
      return { get: (p) => { r.gets++; return store.get(p); }, put: (p, b, m) => store.put(p, b, m), close: async () => { r.closed++; } };
    },
  });
  r.c.subscribe(() => { const s = r.c.getState(); if (s.sas) r.sasSeen = s.sas; });
  r.live = () => r.timers.filter((t) => t.live);
  return r;
}

async function ready() {
  const r = rig();
  r.link = await r.desk.open(T);
  await r.c.start();
  assert.equal(r.c.getState().phase, 'pairing');
  await r.c.pair({ email: EMAIL, password: PW, name: 'Laptop browser' });
  assert.equal(r.c.getState().phase, 'ready', r.c.getState().error ?? '');
  return r;
}

test('no link and no record: phase none; a memory: link is refused with a clear text', async () => {
  const r = rig();
  await r.c.start();
  assert.equal(r.c.getState().phase, 'none');
  const qr = await createFakeDesktop({ store: createTamperStore() }).open(T);
  assert.equal(r.c.acceptLink(qr), false);
  assert.equal(r.c.getState().error, TEXT.unsupported_store);
  assert.equal(r.c.acceptLink('https://llm-ide.com/#pair=junk'), false);
  assert.equal(r.c.getState().error, TEXT.bad_pair);
});

test("pairing: wrong password keeps the link; the right one shows the desktop's SAS and links; the password is never persisted", async () => {
  const r = rig();
  r.link = await r.desk.open(T);
  await r.c.start();
  await r.c.pair({ email: EMAIL, password: 'wrong', name: 'Laptop browser' });
  assert.equal(r.c.getState().phase, 'pairing');
  assert.equal(r.c.getState().error, TEXT.SYNC_AUTH_FAILED);
  await r.c.pair({ email: EMAIL, password: PW, name: 'Laptop browser' });
  const s = r.c.getState();
  assert.equal(s.phase, 'ready');
  assert.equal(r.sasSeen, r.desk.lastSas, 'the browser showed the code the desktop shows');
  assert.equal(s.notice, "Waiting for the desktop's first snapshot.");
  const rec = await r.keystore.load();
  assert.equal(rec.megaEmail, EMAIL);
  const flat = JSON.stringify(rec, (k, v) => (v instanceof Uint8Array || (typeof CryptoKey !== 'undefined' && v instanceof CryptoKey) ? undefined : v));
  assert.ok(!flat.includes(PW), 'no password in the device record');
  assert.ok(!JSON.stringify(s).includes(PW), 'no password in controller state');
});

test('ready: polls every 30 s, shows the snapshot, and marks it stale after validUntil', async () => {
  const r = await ready();
  assert.equal(r.live().length, 1); assert.equal(r.live()[0].ms, POLL_MS);
  await r.desk.publish(r.dev, kinds(), r.clock, { validFor: 60_000 });
  await r.c.refresh();
  const s = r.c.getState();
  assert.equal(s.snapshot.kinds.chats.items[0].title, 'Chat a');
  assert.equal(s.stale, false); assert.equal(s.notice, null); assert.equal(s.error, null);
  r.clock += 61_000;
  await r.c.refresh();
  assert.equal(r.c.getState().stale, true);
});

test('queue a prompt, the desktop answers, the answer appears and the queue empties', async () => {
  const r = await ready();
  assert.equal(await r.c.send('what changed?'), true);
  assert.deepEqual(r.c.getState().pending.map((p) => p.text), ['what changed?']);
  await r.desk.drain(r.dev, undefined, r.clock);
  await r.c.refresh();
  const s = r.c.getState();
  assert.deepEqual(s.pending, []);
  assert.equal(s.answered[0].reply, 'echo: what changed?');
  assert.equal(s.answered[0].text, 'what changed?');
  for (let i = 0; i < 5; i++) assert.equal(await r.c.send(`q${i}`), true);
  assert.equal(await r.c.send('one too many'), false);
  assert.match(r.c.getState().error, /already waiting/);
});

test('offline stops polling; online refreshes at once; pause (desktop live) and resume', async () => {
  const r = await ready();
  r.net[0](false);
  assert.equal(r.c.getState().online, false);
  assert.equal(r.live().length, 0);
  const before = r.gets;
  r.net[0](true); await flush(); await flush();
  assert.ok(r.gets > before, 'came back online: checked at once');
  r.c.pause();
  assert.equal(r.live().length, 0);
  const g = r.gets;
  await r.c.refresh();
  assert.equal(r.gets, g, 'paused: no storage reads');
  r.c.resume(); await flush(); await flush();
  assert.ok(r.gets > g);
});

test('unreachable storage backs off up to 15 min; a lost session locks and drops the snapshot', async () => {
  const r = await ready();
  r.store.onGet = () => { throw new SyncStoreError('SYNC_UNREACHABLE'); };
  await r.c.refresh();
  assert.equal(r.live()[0].ms, POLL_MS * 2);
  await r.c.refresh();
  assert.equal(r.live()[0].ms, POLL_MS * 4);
  assert.equal(r.c.getState().error, TEXT.SYNC_UNREACHABLE);
  r.store.onGet = () => { throw new SyncStoreError('SYNC_SESSION_EXPIRED'); };
  await r.c.refresh();
  const s = r.c.getState();
  assert.equal(s.phase, 'locked'); assert.equal(s.snapshot, null); assert.equal(s.error, TEXT.SYNC_SESSION_EXPIRED);
  assert.equal(r.live().length, 0);
  r.store.onGet = null;
  await r.c.unlock({ email: EMAIL, password: 'wrong' });
  assert.equal(r.c.getState().phase, 'locked');
  await r.c.unlock({ email: EMAIL, password: PW });
  assert.equal(r.c.getState().phase, 'ready');
});

test('a file that fails verification keeps the last verified snapshot and says so', async () => {
  const r = await ready();
  await r.desk.publish(r.dev, kinds('a'), r.clock);
  await r.c.refresh();
  r.store.onGet = (p, b) => { if (!p.endsWith('/manifest.bin') || !b) return b; const x = Buffer.from(b); x[40] ^= 1; return x; };
  await r.c.refresh();
  const s = r.c.getState();
  assert.equal(s.snapshot.kinds.chats.items[0].title, 'Chat a');
  assert.match(s.error, /failed verification/);
});

test('a removed device shows "removed"; lock and forget', async () => {
  const r = await ready();
  await r.c.lock();
  assert.equal(r.c.getState().phase, 'locked'); assert.equal(r.c.getState().snapshot, null);
  await r.c.unlock({ email: EMAIL, password: PW });
  await r.store.removeTree(`${r.desk.sid}/d/${r.dev.dir}`);
  await r.c.refresh();
  assert.equal(r.c.getState().phase, 'removed');
  assert.ok(await r.keystore.load(), 'the record stays until the user forgets it');
  await r.c.forget();
  assert.equal(r.c.getState().phase, 'none');
  assert.equal(await r.keystore.load(), null);
});

test('a stored record starts locked with the remembered email', async () => {
  const r = await ready();
  r.c.dispose();
  const c2 = createSyncController({ keystore: r.keystore, takePairLink: () => null, onNetwork: () => () => {}, online: () => true, openStore: async () => { throw new SyncStoreError('SYNC_AUTH_FAILED'); } });
  await c2.start();
  assert.equal(c2.getState().phase, 'locked');
  assert.equal(c2.getState().email, EMAIL);
  c2.dispose();
});

test('a retry after a transient failure once the claim landed reuses the same claim (contract 4c), so the slot is not contested', async () => {
  const r = rig();
  r.link = await r.desk.open(T);
  await r.c.start();
  const claims = [];
  const put = r.store.put.bind(r.store);
  let failOnce = true;
  r.store.put = async (p, b, m) => {
    if (p.includes('/e/') && !p.endsWith('/ack.bin')) {
      claims.push({ p, b: Buffer.from(b).toString('base64') });
      await put(p, b, m);
      if (failOnce) { failOnce = false; throw new SyncStoreError('SYNC_UNREACHABLE'); } // landed, but the answer was lost
      return;
    }
    return put(p, b, m);
  };
  await r.c.pair({ email: EMAIL, password: PW, name: 'Laptop browser' });
  assert.equal(r.c.getState().phase, 'pairing', 'the link is kept for a retry');
  await r.c.pair({ email: EMAIL, password: PW, name: 'Another name' });
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[1], claims[0], 'same claim name and bytes');
  assert.equal(r.c.getState().phase, 'ready', r.c.getState().error ?? '');
});

test('own server: pairs with no login and reopens without unlock', async () => {
  const r = rig('sftp:llm-ide.com');
  r.link = await r.desk.open(T);
  await r.c.start();
  assert.equal(r.c.getState().phase, 'pairing');
  assert.equal(r.c.getState().login, false);
  await r.c.pair({ email: '', password: '', name: 'Laptop browser' });
  assert.equal(r.c.getState().phase, 'ready', r.c.getState().error ?? '');
  r.c.dispose();
  const again = createSyncController({ keystore: r.keystore, takePairLink: () => null, onNetwork: () => () => {}, online: () => true,
    setTimer: () => null, clearTimer: () => {}, now: () => r.clock,
    openStore: async ({ st }) => { assert.equal(st, 'sftp:llm-ide.com'); return { get: (p) => r.store.get(p), put: (p, b) => r.store.put(p, b), close: async () => {} }; } });
  await again.start();
  assert.equal(again.getState().phase, 'ready', 'no unlock step for the own server');
});

test('a Box pairing link opens Box (not MEGA), stores the Box app on the device', async () => {
  const opened = [];
  const fakeStore = { async get() { return null; }, async put() {}, async close() {} };
  const link = `https://pwa.example/#pair=${encodeURIComponent(`sv=1&sid=${'A'.repeat(22)}&sfp=${'B'.repeat(43)}&dir=${'C'.repeat(22)}&slot=${'D'.repeat(22)}&es=${'E'.repeat(22)}&st=box%3Allmide-sync&bi=cid0123456789abcdef&bs=csec0123456789abcdef`)}`;
  const c = createSyncController({ keystore: memoryKeyStore(), takePairLink: () => null, onNetwork: () => () => {}, online: () => true,
    openStore: async () => { throw new Error('MEGA must not be used'); },
    openBox: async (cfg) => { opened.push(cfg); return fakeStore; } });
  await c.start();
  assert.equal(c.acceptLink(link), true);
  assert.equal(c.getState().store, 'box');
  await c.pair({ email: '', password: '', name: 'Browser' });
  assert.deepEqual(opened[0], { clientId: 'cid0123456789abcdef', clientSecret: 'csec0123456789abcdef', folder: 'llmide-sync' });
});
