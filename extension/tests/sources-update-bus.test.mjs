// G7: the `sources.update` bus kind (T1) runs Google Calendar / Drive and iCal syncs through the bus executor, and
// re-checks at EXECUTION time that the connection still exists and its scope is still granted. Fake Google/feed
// transports only: no real network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_BUS;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_sources-update-bus-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const store = await import('../kb/google-store.mjs');
const ical = await import('../kb/ical-store.mjs');
const bstore = await import('../kb/bus-store.mjs');
const gf = await import('../connectors/google/google-fetch.mjs');
const f = await import('../connectors/ical/ical-fetch.mjs');
const { scopesFor } = await import('../connectors/google/google-scopes.mjs');
const { createBus, approvalNonce } = await import('../routes/bus/executor.mjs');
const { _setIcalClockForTests } = await import('../routes/calendar-ical.mjs');
const { makeTransport, jsonResponse, textResponse, installTripwire, fixture } = await import('./helpers/google-fixture.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `su-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 's' }).id;
const ACCESS = 'ya29.SU-ACCESS-TOKEN-0123456789abcdefghij';
const REFRESH = '1//0gSU-REFRESH-TOKEN-0123456789abcdefghij';
const ICAL_URL = 'https://calendar.google.com/calendar/ical/me%40example.com/private-0123456789abcdef0123456789abcdef/basic.ics';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(15); } };

let tripwire; let bus;
before(() => {
  tripwire = installTripwire(); gf._setGoogleSleepForTests(async () => {}); f._setIcalSleepForTests(async () => {});
  _setIcalClockForTests(() => Date.parse('2025-11-10T00:00:00Z'));
  bus = createBus({ graceMs: 50, sweepMs: 60_000 }); bus.start();
});
after(async () => {
  await bus.stop();
  gf._setGoogleFetchForTests(null); gf._setGoogleSleepForTests(null); f._setIcalFetchForTests(null); f._setIcalSleepForTests(null); _setIcalClockForTests(null);
  tripwire.restore(); assert.deepEqual(tripwire.hits, []); kb.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

function gcalTransport() {
  const t = makeTransport();
  t.on('/token', () => jsonResponse(200, { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' }));
  t.on((x) => x.pathname.endsWith('/events'), (x) => jsonResponse(200, x.searchParams.get('pageToken') === 'PG2' ? fixture('gcal/events_full_2.json') : fixture('gcal/events_full_1.json')));
  t.on('/calendar/v3/users/me/calendarList', () => jsonResponse(200, fixture('gcal/calendar_list.json')));
  gf._setGoogleFetchForTests(t);
  return t;
}
function seedAccount(userId, accountId, products = ['gcal']) {
  store.upsertGoogleAccount(userId, { accountId, email: 'me@example.com', scopes: scopesFor(products), products, driveContent: false });
  for (const [k, v] of [['refreshToken', REFRESH], ['clientId', 'cid.apps.googleusercontent.com'], ['clientSecret', 'GOCSPX-su-secret-0123456789']]) setSecret(db, userId, `google.acct.${accountId}.${k}`, v);
}
function seedIcal(userId, sourceId) {
  ical.addIcalSource(userId, { sourceId, name: 'Team', idPrefix: 'me@exa', host: 'calendar.google.com' });
  setSecret(db, userId, `ical.src.${sourceId}.url`, ICAL_URL);
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(200, fs.readFileSync(path.join(HERE, 'fixtures', 'ical', 'google-style.ics'), 'utf8'))));
}

let k = 0;
/** Enqueue from `client`, approve from the desktop, wait for a terminal state. */
async function run(userId, args, { client = 'ios-native', approve = true, between } = {}) {
  const out = bus.receive(userId, { v: 1, kind: 'sources.update', idem: `su-${++k}-${Date.now()}`, args }, { client });
  const id = out.command.id;
  assert.equal(out.command.state, 'awaiting_approval', 'T1 waits for the desktop');
  if (between) await between();
  if (approve) {
    const hash = db.prepare('SELECT args_hash FROM bus_commands WHERE user_id = ? AND id = ?').get(userId, id).args_hash;
    bus.approve(userId, id, { client: 'desktop-ui', nonce: approvalNonce(userId, id, hash) });
  }
  await until(() => ['succeeded', 'failed', 'interrupted'].includes(bstore.getCommand(userId, id).state));
  return bstore.getCommand(userId, id);
}

test('sources.update is available at T1: a phone enqueue waits for approval; the extension and PWA may not start it', () => {
  const u = mkUser();
  assert.throws(() => bus.receive(u, { v: 1, kind: 'sources.update', idem: 'x1', args: {} }, { client: 'phone-pwa' }), { code: 'TIER_DENIED' });
  assert.throws(() => bus.receive(u, { v: 1, kind: 'sources.update', idem: 'x2', args: {} }, { client: 'extension' }), { code: 'TIER_DENIED' });
  const o = bus.receive(u, { v: 1, kind: 'sources.update', idem: 'x3', args: {} }, { client: 'ios-native' });
  assert.equal(o.command.state, 'awaiting_approval');
});

test('runs a Google Calendar sync and an iCal sync through the executor, per user', async () => {
  const u = mkUser(); const other = mkUser();
  const acct = 'aaaaaaaaaaaa'; const src = 'bbbbbbbbbbbb';
  seedAccount(u, acct); seedIcal(u, src); gcalTransport();
  const cmd = await run(u, { sourceIds: [`gcal:${acct}`, `ical:${src}`] });
  assert.equal(cmd.state, 'succeeded', JSON.stringify(cmd));
  assert.equal(cmd.result.synced, 2);
  assert.deepEqual(cmd.result.results.map((r) => r.status), ['ok', 'ok']);
  assert.ok(store.getSyncState(u, 'gcal', acct).cursor, 'gcal cursor moved');
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sources WHERE user_id = ? AND ref LIKE ?").get(u, `ical:${src}:%`).c > 0, true);
  const blob = JSON.stringify(cmd);
  for (const s of [ACCESS, REFRESH, 'GOCSPX-su-secret', 'private-0123456789abcdef']) assert.ok(!blob.includes(s), 'no secret in the result');
  // another user naming the same ids touches nothing of u's
  const c2 = await run(other, { sourceIds: [`gcal:${acct}`] });
  assert.equal(c2.state, 'failed'); assert.equal(c2.error, 'not_found');
});

test('no sourceIds syncs every eligible source the user has; unsupported ids are skipped, not run', async () => {
  const u = mkUser(); const acct = 'cccccccccccc';
  seedAccount(u, acct); gcalTransport();
  const cmd = await run(u, { sourceIds: [`gmail:${acct}`, `gcal:${acct}`] });
  assert.equal(cmd.state, 'succeeded');
  assert.deepEqual(cmd.result.results.map((r) => [r.sourceId, r.status]), [[`gmail:${acct}`, 'skipped'], [`gcal:${acct}`, 'ok']]);
  const all = await run(u, {});
  assert.equal(all.state, 'succeeded'); assert.equal(all.result.synced, 1);
});

test('execution-time re-check: the connection is deleted after approval -> refused, nothing written', async () => {
  const u = mkUser(); const acct = 'dddddddddddd'; const src = 'eeeeeeeeeeee';
  seedAccount(u, acct); seedIcal(u, src); const t = gcalTransport();
  const cmd = await run(u, { sourceIds: [`gcal:${acct}`, `ical:${src}`] }, {
    between: () => { store.deleteGoogleAccount(u, acct); ical.deleteIcalSource(u, src); },
  });
  assert.equal(cmd.state, 'failed'); assert.equal(cmd.error, 'not_found');
  assert.equal(t.calls.filter((c) => c.path.includes('/events')).length, 0, 'no Google call after the connection went');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM sources WHERE user_id = ? AND (ref LIKE ? OR ref LIKE ?)').get(u, `gcal:%`, `ical:${src}:%`).c, 0);
});

test('execution-time re-check: the scope is no longer granted -> refused, no Google events call', async () => {
  const u = mkUser(); const acct = 'ffffffffffff';
  seedAccount(u, acct, ['gcal', 'gdrive']); const t = gcalTransport();
  const cmd = await run(u, { sourceIds: [`gcal:${acct}`] }, {
    // the account is re-recorded with only Drive scopes (the user unticked Calendar at Google)
    between: () => store.upsertGoogleAccount(u, { accountId: acct, email: 'me@example.com', scopes: scopesFor(['gdrive']), products: ['gdrive'], driveContent: false }),
  });
  assert.equal(cmd.state, 'failed'); assert.equal(cmd.error, 'not_found');
  assert.equal(t.calls.filter((c) => c.path.includes('/events')).length, 0);
  assert.equal(store.getSyncState(u, 'gcal', acct).cursor ?? null, null);
});

test('a denied approval never syncs', async () => {
  const u = mkUser(); const acct = 'abababababab';
  seedAccount(u, acct); const t = gcalTransport();
  const o = bus.receive(u, { v: 1, kind: 'sources.update', idem: `d-${Date.now()}`, args: { sourceIds: [`gcal:${acct}`] } }, { client: 'ios-native' });
  bus.deny(u, o.command.id, { client: 'desktop-ui' });
  await sleep(100);
  assert.equal(bstore.getCommand(u, o.command.id).state, 'denied');
  assert.equal(t.calls.length, 0);
});

test('sourceIds shape is validated at receipt', () => {
  const u = mkUser();
  assert.throws(() => bus.receive(u, { v: 1, kind: 'sources.update', idem: 'v1', args: { sourceIds: ['has space'] } }, { client: 'ios-native' }), { code: 'INVALID_ARGS' });
});
