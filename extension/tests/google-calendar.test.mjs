// Calendar connector (connectors/google/gcal.mjs), Pattern A: fixtures only, temp DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_google-calendar-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const gc = await import('../connectors/google/gcal.mjs');
const gf = await import('../connectors/google/google-fetch.mjs');
const { makeTransport, jsonResponse, installTripwire, fixture } = await import('./helpers/google-fixture.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `cal-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'c' }).id;
const session = { ensure: async () => 'TOKEN', refresh: async () => 'TOKEN' };
const sleepImpl = async () => {};
const ACCT = 'abc123abc123';
const NOW = Date.parse('2025-11-01T00:00:00Z');

let tripwire;
before(() => { tripwire = installTripwire(); });
after(() => { gf._setGoogleFetchForTests(null); tripwire.restore(); assert.deepEqual(tripwire.hits, []); kb.closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

const rowsFor = (userId, prefix = `gcal:${ACCT}:`) => db.prepare("SELECT ref, chunk_idx, title, body, meta FROM sources WHERE user_id = ? AND kind = 'doc' AND ref LIKE ? ORDER BY ref, chunk_idx").all(userId, `${prefix}%`);

function calendar({ gone } = {}) {
  const t = makeTransport();
  t.on((u) => u.pathname.endsWith('/events'), (u) => {
    if (gone && u.searchParams.has('syncToken')) return jsonResponse(410, fixture('gcal/events_410.json'));
    if (u.searchParams.has('syncToken')) return jsonResponse(200, fixture('gcal/events_incr.json'));
    return jsonResponse(200, u.searchParams.get('pageToken') === 'PG2' ? fixture('gcal/events_full_2.json') : fixture('gcal/events_full_1.json'));
  });
  t.on('/calendar/v3/users/me/calendarList', () => jsonResponse(200, fixture('gcal/calendar_list.json')));
  gf._setGoogleFetchForTests(t);
  return t;
}

test('options are validated and clamped', () => {
  const o = gc.normalizeCalendarOptions({ calendarIds: ['primary', 'x\ny', 'team@group.calendar.google.com'], daysBack: 9999, daysAhead: -5 });
  assert.deepEqual(o.calendarIds, ['primary', 'team@group.calendar.google.com']); assert.equal(o.daysBack, 365); assert.equal(o.daysAhead, 0);
  assert.deepEqual(gc.normalizeCalendarOptions({}), { calendarIds: ['primary'], daysBack: 30, daysAhead: 90 });
});

test('full sync: window params, singleEvents, pagination, rows per event, cancelled skipped, syncToken saved', async () => {
  const userId = mkUser();
  const t = calendar();
  const r = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  assert.equal(r.pending, false); assert.equal(r.events, 3); assert.equal(r.cancelled, 1);
  assert.deepEqual(JSON.parse(r.nextCursor), { cals: { primary: { syncToken: 'SYNC1' } } });
  const first = t.callsTo('/events')[0];
  assert.equal(first.query.get('singleEvents'), 'true'); assert.equal(first.query.get('showDeleted'), 'true');
  assert.equal(first.query.get('timeMin'), new Date(NOW - 30 * 86400000).toISOString());
  assert.equal(first.query.get('timeMax'), new Date(NOW + 90 * 86400000).toISOString());
  assert.ok(!first.query.has('syncToken'));
  assert.equal(t.callsTo('/events')[1].query.get('pageToken'), 'PG2');
  assert.ok(t.calls.every((c) => c.host === 'www.googleapis.com' && c.path.startsWith('/calendar/v3/')));
  const refs = [...new Set(rowsFor(userId).map((x) => x.ref))];
  assert.deepEqual(refs, ['gcal:abc123abc123:primary:abc', 'gcal:abc123abc123:primary:abc_20251110T010000Z', 'gcal:abc123abc123:primary:solo']);
  const sync = rowsFor(userId).find((x) => x.ref.endsWith(':abc'));
  const meta = JSON.parse(sync.meta);
  assert.equal(meta.untrusted, true); assert.equal(meta.source, 'gcal'); assert.equal(meta.eventId, 'abc');
  assert.deepEqual(meta.attendees.map((a) => a.email), ['me@example.com', 'pat@example.com'], 'attendee addresses are kept');
  assert.match(sync.body, /Where: Room 4/); assert.match(sync.body, /Attendees:/);
});

test('hostile description: no script, remote image or javascript: link; secrets redacted; conference link is text only and never fetched', async () => {
  const userId = mkUser();
  const t = calendar();
  await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  const body = rowsFor(userId).filter((x) => x.ref.endsWith(':abc')).map((x) => x.body).join('\n');
  for (const bad of ['<script', 'fetch(', 'evil.example.com', 't.example/p.gif', 'javascript:', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']) assert.ok(!body.includes(bad), bad);
  assert.match(body, /Agenda/);
  assert.match(body, /https:\/\/meet\.google\.com\/aaa-bbbb-ccc/);
  assert.ok(!t.calls.some((c) => /meet\.google\.com|docs\.google\.com|www\.google\.com/.test(c.host)), 'no URL from event data is fetched');
});

test('incremental: syncToken only (no window), updated event replaced, cancelled instance deleted by EXACT ref (a prefix sibling survives)', async () => {
  const userId = mkUser();
  calendar();
  const first = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  const t = calendar();
  const r = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: first.nextCursor, options: {}, now: NOW, sleepImpl });
  const call = t.callsTo('/events')[0];
  assert.equal(call.query.get('syncToken'), 'SYNC1'); assert.ok(!call.query.has('timeMin') && !call.query.has('timeMax'));
  assert.equal(r.calendars[0].mode, 'incremental');
  assert.deepEqual(JSON.parse(r.nextCursor), { cals: { primary: { syncToken: 'SYNC2' } } });
  const refs = [...new Set(rowsFor(userId).map((x) => x.ref))];
  assert.ok(!refs.includes('gcal:abc123abc123:primary:abc_20251110T010000Z'), 'cancelled instance gone');
  assert.ok(refs.includes('gcal:abc123abc123:primary:abc'), 'master with the same id prefix survives');
  assert.match(rowsFor(userId).find((x) => x.ref.endsWith(':solo')).title, /moved/);
  assert.equal(r.cancelled, 1);
});

test('410 Gone: token cleared, full resync, rows not seen again are dropped only after the pass finished', async () => {
  const userId = mkUser();
  calendar();
  const first = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  // a stale row from an event that no longer exists (older than the resync start)
  db.prepare("INSERT INTO sources (user_id, kind, ref, chunk_idx, title, body, meta, indexed_at) VALUES (?, 'doc', ?, 0, 'old', 'old', '{}', '2000-01-01 00:00:00')").run(userId, 'gcal:abc123abc123:primary:stale');
  const t = calendar({ gone: true });
  const r = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: first.nextCursor, options: {}, now: Date.now(), sleepImpl });
  assert.equal(r.calendars[0].resynced, true); assert.equal(r.calendars[0].mode, 'full');
  assert.deepEqual(JSON.parse(r.nextCursor), { cals: { primary: { syncToken: 'SYNC1' } } });
  const eventCalls = t.callsTo('/events');
  assert.ok(eventCalls[0].query.has('syncToken')); assert.ok(eventCalls.some((c) => c.query.has('timeMin')));
  const refs = [...new Set(rowsFor(userId).map((x) => x.ref))];
  assert.ok(!refs.includes('gcal:abc123abc123:primary:stale'));
  assert.equal(refs.length, 3);
});

test('run cap: an unfinished run keeps its page token and finishes on the next run without losing events', async () => {
  const userId = mkUser();
  calendar();
  const r1 = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl, limits: { maxEventsPerRun: 1 } });
  assert.equal(r1.pending, true);
  const c1 = JSON.parse(r1.nextCursor).cals.primary;
  assert.equal(c1.pageToken, 'PG2'); assert.ok(c1.full);
  const r2 = await gc.syncCalendars({ session, userId, accountId: ACCT, cursor: r1.nextCursor, options: {}, now: NOW + 5000, sleepImpl });
  assert.equal(r2.pending, false);
  assert.deepEqual(JSON.parse(r2.nextCursor), { cals: { primary: { syncToken: 'SYNC1' } } });
  assert.equal(new Set(rowsFor(userId).map((x) => x.ref)).size, 3);
});

test('per-user isolation: another user sees none of the rows and the same refs do not collide', async () => {
  const u1 = mkUser(); const u2 = mkUser();
  calendar();
  await gc.syncCalendars({ session, userId: u1, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  assert.equal(rowsFor(u2).length, 0);
  await gc.syncCalendars({ session, userId: u2, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  assert.equal(rowsFor(u1).length, rowsFor(u2).length);
});

test('errors: 401 refresh, malformed JSON, persistent 5xx carry stable codes and no body text', async () => {
  const userId = mkUser();
  let tok = 'T0';
  const s = { ensure: async () => tok, refresh: async () => { tok = 'T1'; return tok; } };
  let n401 = 0;
  const t = makeTransport();
  t.on((u) => u.pathname.endsWith('/events'), (u, i, call) => (call.headers.authorization === 'Bearer T0' && n401++ < 1 ? jsonResponse(401, {}) : jsonResponse(200, fixture('gcal/events_full_2.json'))));
  gf._setGoogleFetchForTests(t);
  const ok = await gc.syncCalendars({ session: s, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl });
  assert.equal(ok.events, 1);
  gf._setGoogleFetchForTests(makeTransport().on(() => true, () => new Response('{"items":', { status: 200 })));
  await assert.rejects(() => gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl }), (e) => e.code === 'GOOGLE_BAD_JSON');
  gf._setGoogleFetchForTests(makeTransport().on(() => true, () => jsonResponse(503, { error: { message: 'LEAK ya29.LEAKLEAKLEAKLEAKLEAKLEAK' } })));
  await assert.rejects(() => gc.syncCalendars({ session, userId, accountId: ACCT, cursor: null, options: {}, now: NOW, sleepImpl }), (e) => e.code === 'GOOGLE_RATE_LIMITED' && !/LEAK/.test(e.message));
});

test('listCalendars: pages of the calendar list, read-only fields', async () => {
  const t = calendar();
  const list = await gc.listCalendars({ session, sleepImpl });
  assert.deepEqual(list.map((c) => c.id), ['primary-id@example.com', 'team@group.calendar.google.com']);
  assert.equal(list[0].primary, true);
  assert.ok(t.callsTo('calendarList').length === 1);
});
