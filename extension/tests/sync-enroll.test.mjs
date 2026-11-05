// Enrollment end to end with the Node reference device: QR -> claim -> pinned claim + signed ack -> same SAS on both
// screens -> registry (desktop tier) -> wrap -> the device reads its first snapshot. es never reaches the store or DB.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_sync-enroll-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const st = await import('../kb/sync-state.mjs');
const E = await import('../core/sync-enroll.mjs');
const { createMemoryStore } = await import('../connectors/sync-store/index.mjs');
const { publishOnce } = await import('../routes/sync/producer.mjs');
const { startEnrollment, pollEnrollment, confirmEnrollment, cancelEnrollment, ENROLL, _resetEnrollmentsForTest } = await import('../routes/sync/enroll.mjs');
const { createReferenceDevice } = await import('./helpers/sync-device.mjs');

const T = 1_762_400_000_000;
let n = 0;
const user = () => users.registerUser(kb.getDb(), { email: `se-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'e' }).id;
const kinds = () => Object.fromEntries(['chats', 'meetings', 'plans', 'usage'].map((k) => [k, Buffer.from(JSON.stringify({ v: 1, kind: k, generatedAt: 1, truncated: false, items: [] }))]));
function setup() {
  const u = user();
  st.ensureSyncState(u, { storeKind: 'memory', storeConfig: {} });
  st.setSyncEnabled(u, true);
  return { u, store: createMemoryStore(), sid: st.getSyncState(u).syncId };
}
beforeEach(() => _resetEnrollmentsForTest());

test('happy path: same SAS on both screens, desktop tier, wrap, first snapshot, slot gone', async () => {
  const { u, store, sid } = setup();
  const { qr, tier, expiresAt } = await startEnrollment(u, { store, tier: 'ios', now: T });
  assert.equal(tier, 'ios'); assert.equal(expiresAt, T + ENROLL.claimMs);
  assert.ok(qr.startsWith('llmide://pair?sv=1&'));
  const pair = E.parsePair(qr);
  assert.equal(pair.sid, sid);
  assert.equal(pair.st, 'memory:');
  assert.equal((await pollEnrollment(u, { now: T + 500 })).phase, 'waiting');

  const dev = createReferenceDevice({ tier: 'ios', name: 'My iPhone' });
  await dev.scanAndClaim(store, qr, { now: T + 600 });
  assert.equal(await dev.readAck(store), null, 'no ack before the desktop has seen the claim');
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(p.phase, 'confirm'); assert.equal(p.name, 'My iPhone'); assert.match(p.sas, /^[0-9]{6}$/);
  assert.equal(await dev.readAck(store), p.sas, 'both screens show the same code');
  assert.equal(st.listSyncDevices(u).length, 0, 'nothing is registered before the user confirms');

  assert.deepEqual(await confirmEnrollment(u, { now: T + 2000 }), { deviceId: dev.deviceId });
  const [row] = st.listSyncDevices(u);
  assert.equal(row.deviceId, dev.deviceId); assert.equal(row.tier, 'ios'); assert.equal(row.dir, pair.dir); assert.equal(row.name, 'My iPhone');
  assert.ok(row.signingSpki.equals(dev.signingSpki)); assert.ok(row.ecdhSpki.equals(dev.ecdhSpki));
  assert.equal(await dev.readWrap(store), true);
  assert.equal(dev.epoch, st.getSyncState(u).epoch);
  await publishOnce({ userId: u, store, now: T + 3000, loadKinds: kinds });
  const snap = await dev.readSnapshot(store);
  assert.deepEqual(Object.keys(snap.kinds).sort(), ['chats', 'meetings', 'plans', 'usage']);
  assert.deepEqual(await store.list(`${sid}/e/${pair.slot}`), [], 'the slot is deleted');
  assert.equal((await pollEnrollment(u, { now: T + 4000 })).phase, 'none');

  const esBytes = Buffer.from(pair.es, 'base64url');
  for (const [p2, bytes] of store.dump()) assert.ok(!bytes.includes(esBytes) && !bytes.includes(Buffer.from(pair.es)), `es not in ${p2}`);
  kb.getDb().pragma('wal_checkpoint(TRUNCATE)');
  assert.ok(!fs.readFileSync(tmpDb).includes(Buffer.from(pair.es)), 'es not in the database');
});

test('the web form carries the same fields; the default web origin is llm-ide.com', async () => {
  const { u, store } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'web', now: T, env: {} });
  assert.ok(qr.startsWith('https://llm-ide.com/#pair=sv%3D1%26'));
  const dev = createReferenceDevice({ tier: 'web', name: 'Laptop browser' });
  await dev.scanAndClaim(store, qr, { now: T });
  const p = await pollEnrollment(u, { now: T + 1000 });
  assert.equal(await dev.readAck(store), p.sas);
  const { qr: dev2 } = await startEnrollment(u, { store, tier: 'web', now: T, env: { LLMIDE_SYNC_WEB_ORIGIN: 'http://localhost:5173' } });
  assert.ok(dev2.startsWith('http://localhost:5173/#pair='));
  const { qr: bad } = await startEnrollment(u, { store, tier: 'web', now: T, env: { LLMIDE_SYNC_WEB_ORIGIN: 'javascript:alert(1)' } });
  assert.ok(bad.startsWith('https://llm-ide.com/#pair='), 'a bad origin falls back to the default');
});

test('no claim within 120 s: expired, key.bin and the slot are removed, nothing registered', async () => {
  const { u, store, sid } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const pair = E.parsePair(qr);
  assert.ok(await store.get(`${sid}/d/${pair.dir}/key.bin`));
  const p = await pollEnrollment(u, { now: T + ENROLL.claimMs + 1 });
  assert.equal(p.phase, 'expired');
  assert.equal(await store.get(`${sid}/d/${pair.dir}/key.bin`), null);
  assert.equal(st.listSyncDevices(u).length, 0);
});

test('a confirm more than 120 s after the claim is refused', async () => {
  const { u, store } = setup();
  const { qr } = await startEnrollment(u, { store, tier: 'ios', now: T });
  const dev = createReferenceDevice();
  await dev.scanAndClaim(store, qr, { now: T });
  assert.equal((await pollEnrollment(u, { now: T + 1000 })).phase, 'confirm');
  await assert.rejects(confirmEnrollment(u, { now: T + 1000 + ENROLL.confirmMs + 1 }), (e) => e.code === 'ENROLL_FAILED');
  assert.equal(st.listSyncDevices(u).length, 0);
});

test('cancel and a new start both clean up the old slot; enrollment needs sync on', async () => {
  const { u, store, sid } = setup();
  const a = E.parsePair((await startEnrollment(u, { store, tier: 'ios', now: T })).qr);
  const b = E.parsePair((await startEnrollment(u, { store, tier: 'ios', now: T })).qr);
  assert.equal(await store.get(`${sid}/d/${a.dir}/key.bin`), null, 'the replaced slot is cleaned up');
  await cancelEnrollment(u);
  assert.equal(await store.get(`${sid}/d/${b.dir}/key.bin`), null);
  assert.equal((await pollEnrollment(u, { now: T })).phase, 'none');
  st.setSyncEnabled(u, false);
  await assert.rejects(startEnrollment(u, { store, tier: 'ios', now: T }), (e) => e.code === 'SYNC_OFF');
  await assert.rejects(startEnrollment(u, { store, tier: 'android', now: T }), (e) => e.code === 'VALIDATION_FAILED');
});
