// /kb/calendar-ical/* (routes/calendar-ical.mjs): in-process req/res doubles, the real handler, a fixture transport in
// place of the feed host. Set ICAL_DUMP_FIXTURES=<dir> to write every exchange as a contract fixture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_ical-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const vault = await import('../server/vault.mjs');
const { handleCalendarIcalRoutes, _setIcalClockForTests } = await import('../routes/calendar-ical.mjs');
const f = await import('../connectors/ical/ical-fetch.mjs');
const { makeTransport, textResponse, installTripwire } = await import('./helpers/google-fixture.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `ic-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'i' }).id;
const TOKEN = 'private-0123456789abcdef0123456789abcdef';
const urlFor = (id, tok = TOKEN) => `https://calendar.google.com/calendar/ical/${id}/${tok}/basic.ics`;
const GOOD = urlFor('me%40example.com');
const fx = (name) => fs.readFileSync(path.join(HERE, 'fixtures', 'ical', name), 'utf8');
const NOW = Date.parse('2025-11-10T00:00:00Z');

let tripwire; const captured = [];
const origOut = process.stdout.write.bind(process.stdout); const origErr = process.stderr.write.bind(process.stderr);
before(() => {
  tripwire = installTripwire(); f._setIcalSleepForTests(async () => {}); _setIcalClockForTests(() => NOW);
  process.stdout.write = (c, ...a) => { captured.push(String(c)); return origOut(c, ...a); };
  process.stderr.write = (c, ...a) => { captured.push(String(c)); return origErr(c, ...a); };
});
after(() => {
  process.stdout.write = origOut; process.stderr.write = origErr;
  f._setIcalFetchForTests(null); f._setIcalSleepForTests(null); _setIcalClockForTests(null); tripwire.restore();
  assert.deepEqual(tripwire.hits, []); kb.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  if (process.env.ICAL_DUMP_FIXTURES) dump(process.env.ICAL_DUMP_FIXTURES);
});

const exchanges = [];
function makeRes() {
  return { statusCode: 200, headers: {}, _body: '', headersSent: false,
    writeHead(c, h) { this.statusCode = c; this.headersSent = true; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; }, end(c) { if (c) this._body += c; this.ended = true; } };
}
async function call(userId, method, url, body, { record = true, label } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Object.assign(Readable.from(chunks), { method, url, headers: {} });
  const res = makeRes();
  const handled = await handleCalendarIcalRoutes(req, res, { userId, url });
  if (!handled) return { handled: false };
  const json = res._body ? JSON.parse(res._body) : null;
  if (record) {
    const request = {};
    if (body !== undefined) request.body = body;
    const pm = /^\/kb\/calendar-ical\/sources\/([^/]+)$/.exec(new URL(url, 'http://x').pathname);
    if (pm) request.params = { id: pm[1] };
    exchanges.push({ method, path: new URL(url, 'http://x').pathname, status: res.statusCode, request, response: json, label });
  }
  return { handled: true, status: res.statusCode, json };
}

function dump(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const norm = (v, k) => {
    if (k === 'sourceId') return typeof v === 'string' && /^[a-f0-9]{12}$/.test(v) ? '0123456789ab' : v;
    if (k === 'lastRunAt') return '2025-11-10T00:00:00.000Z';
    if (k === 'id') return typeof v === 'string' && /^[a-f0-9]{12}$/.test(v) ? '0123456789ab' : v;
    if (k === 'url' && typeof v === 'string') return v.split(TOKEN).join('private-EXAMPLEEXAMPLEEXAMPLE').split('me%40example.com').join('example%40example.com');
    return v;
  };
  const walk = (x, k) => (Array.isArray(x) ? x.map((e) => walk(e, k)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, walk(vv, kk)])) : norm(x, k));
  const seen = new Map();
  for (const e of exchanges) {
    const p = e.path.replace(/\/sources\/[^/]+$/, '/sources/:id');
    const base = `${e.method.toLowerCase()}${p.replace(/[/:]/g, '-')}-${e.status}`;
    const c = (seen.get(base) || 0) + 1; seen.set(base, c);
    if (!e.label && c > 1) continue; // one unlabeled example per route and status; every error case is labeled
    const name = e.label ? `${base}-${e.label}` : (c > 1 ? `${base}-${c}` : base);
    const fxo = { endpoint: `${e.method} ${p}`, status: e.status };
    if (Object.keys(e.request).length) fxo.request = walk(e.request, '');
    if (e.response !== null) fxo.response = walk(e.response, '');
    fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(fxo, null, 2)}\n`);
  }
}

const feedHost = (body, extra = {}) => { const t = makeTransport().on(() => true, () => textResponse(200, typeof body === 'function' ? body() : body, extra)); f._setIcalFetchForTests(t); return t; };
async function add(u, name = 'Team', url = GOOD, opts = { record: false }) { const r = await call(u, 'POST', '/kb/calendar-ical/sources', { name, url }, opts); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json.sourceId; }
const rows = (u, sid) => db.prepare("SELECT ref, title, body, meta FROM sources WHERE user_id = ? AND kind = 'doc' AND ref LIKE ?").all(u, `ical:${sid}:%`);
// indexed_at has one-second resolution and the sweep is strictly older-than: age the rows so a fast test sees the sweep.
const age = (u, sid) => db.prepare("UPDATE sources SET indexed_at = datetime('now', '-1 hour') WHERE user_id = ? AND ref LIKE ?").run(u, `ical:${sid}:%`);
const refsOf = (u, sid) => [...new Set(rows(u, sid).map((r) => r.ref))];

test('add: validation, no URL in any response, URL only in the vault', async () => {
  const u = mkUser();
  assert.deepEqual((await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { label: 'empty' })).json, { sources: [] });
  let r = await call(u, 'POST', '/kb/calendar-ical/sources', { name: 'x', url: 5 }, { record: false });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'VALIDATION_FAILED');
  r = await call(u, 'POST', '/kb/calendar-ical/sources', { name: '   ', url: GOOD }, { label: 'no-name' });
  assert.equal(r.status, 400);
  r = await call(u, 'POST', '/kb/calendar-ical/sources', { name: 'x', url: GOOD.replace('https', 'http') }, { label: 'http' });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'ICAL_URL_INVALID');
  r = await call(u, 'POST', '/kb/calendar-ical/sources', { name: 'x', url: 'https://calendar.google.com.evil.com/calendar/ical/a/private-aaaaaaaaaaaa/basic.ics' }, { label: 'lookalike-host' });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'ICAL_HOST_NOT_ALLOWED');
  assert.ok(!JSON.stringify(r.json).includes('evil.com'));
  r = await call(u, 'POST', '/kb/calendar-ical/sources', { name: 'x', url: GOOD.replace('basic.ics', 'other') }, { label: 'bad-shape' });
  assert.equal(r.json.error.code, 'ICAL_URL_INVALID');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ical_sources WHERE user_id = ?').get(u).c, 0, 'nothing stored on a refusal');
  const odd = await call(u, 'POST', '/kb/calendar-ical/sources', { name: ' Odd' + String.fromCodePoint(0x202e) + '   name ', url: urlFor('odd%40example.com', 'private-ffffffffffff') }, { record: false });
  assert.equal(odd.json.name, 'Odd name', 'control and bidi characters are stripped from the label');
  r = await call(u, 'POST', '/kb/calendar-ical/sources', { name: ' My   team cal ', url: GOOD });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['calendarIdPrefix', 'host', 'name', 'nameOnly', 'sourceId']);
  assert.equal(r.json.name, 'My team cal'); assert.equal(r.json.calendarIdPrefix, 'me@examp'); assert.equal(r.json.nameOnly, true);
  assert.ok(!JSON.stringify(r.json).includes(TOKEN));
  const sid = r.json.sourceId;
  assert.equal(vault.getSecret(db, u, `ical.src.${sid}.url`), GOOD);
  // the secret is in no table in the clear
  for (const t of ['ical_sources', 'connector_sync_state', 'audit_log', 'sources', 'user_secrets']) {
    const all = JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all().map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString('latin1') : v]))));
    assert.ok(!all.includes(TOKEN), `${t} holds the secret`);
  }
  const d = await call(u, 'POST', '/kb/calendar-ical/sources', { name: 'again', url: GOOD }, { label: 'duplicate' });
  assert.equal(d.status, 409); assert.equal(d.json.error.code, 'ICAL_DUPLICATE');
  assert.ok(!JSON.stringify(d.json).includes(TOKEN));
});

test('the URL cannot be set or listed through the generic secrets API', () => {
  assert.equal(vault.isUserSettableVaultKey('ical.src.0123456789ab.url'), false);
  assert.ok(!vault.VAULT_KEYS.some((k) => k.startsWith('ical.')));
  assert.throws(() => vault.setSecret(db, 'u', 'ical.src.XYZ.url', 'v'), /Unknown vault key/);
  assert.throws(() => vault.setSecret(db, 'u', 'ical.src.0123456789ab.other', 'v'), /Unknown vault key/);
});

test('list: id, name, prefix, status, never the URL; up to 10 feeds per user', async () => {
  const u = mkUser();
  for (let i = 0; i < 10; i++) await add(u, `Feed ${i}`, urlFor(`cal${i}%40example.com`, `private-${String(i).repeat(12)}`), { record: false });
  const over = await call(u, 'POST', '/kb/calendar-ical/sources', { name: 'eleven', url: urlFor('cal11%40example.com', 'private-bbbbbbbbbbbb') }, { label: 'too-many' });
  assert.equal(over.status, 409); assert.equal(over.json.error.code, 'ICAL_TOO_MANY_SOURCES');
  const l = await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { record: false });
  assert.equal(l.json.sources.length, 10);
  assert.ok(!JSON.stringify(l.json).includes('private-'));
  assert.deepEqual(Object.keys(l.json.sources[0]).sort(), ['calendarIdPrefix', 'host', 'lastError', 'lastRunAt', 'name', 'options', 'sourceId', 'status']);
});

test('sync: Google-style feed becomes instance notes; second run is unchanged; ETag gives not_modified; tombstones; health', async () => {
  const u = mkUser();
  const sid = await add(u, 'Example Team');
  let t = feedHost(fx('google-style.ics'), { etag: '"v1"' });
  let r = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.status, 'ok'); assert.equal(r.json.truncated, false);
  assert.ok(r.json.instances >= 10, `instances ${r.json.instances}`);
  assert.ok(r.json.cancelled >= 2);
  assert.deepEqual(Object.keys(r.json).sort(), ['cancelled', 'events', 'instances', 'removed', 'sourceId', 'status', 'truncated', 'warnings']);
  const refs = refsOf(u, sid);
  assert.ok(refs.every((x) => x.startsWith(`ical:${sid}:`)));
  assert.ok(refs.some((x) => x.endsWith(':20251124T010000Z')), 'the moved occurrence keeps the original identity');
  assert.ok(!refs.some((x) => x.includes('cancelled-003')));
  assert.ok(!refs.some((x) => x.endsWith(':20251117T010000Z')), 'EXDATE');
  const note = rows(u, sid).find((x) => x.title === 'Design review');
  const meta = JSON.parse(note.meta);
  assert.equal(meta.source, 'ical'); assert.equal(meta.untrusted, true);
  assert.ok(!note.body.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'secret-shaped token redacted');
  assert.ok(meta.attendees.some((a) => a.email === 'carol@example.com'));
  const standup = rows(u, sid).find((x) => x.title === 'Weekly standup');
  assert.match(standup.body, /Where: Room 4, Floor 2/);
  assert.match(standup.body, /\[the doc\]\(https:\/\/example\.com\/doc\)/, 'HTML description converted to Markdown');
  assert.ok(!standup.body.includes('<a '));
  // health in connector_sync_state
  const st = (await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { label: 'after-sync' })).json.sources[0];
  assert.deepEqual([st.status, st.lastError], ['idle', null]); assert.ok(st.lastRunAt);
  // same body again: unchanged, rows intact
  r = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { label: 'unchanged' });
  assert.equal(r.json.status, 'unchanged'); assert.equal(refsOf(u, sid).length, refs.length);
  // conditional GET: the host answers 304
  t = makeTransport().on(() => true, (url, i) => (i.headers['If-None-Match'] === '"v1"' ? new Response(null, { status: 304 }) : textResponse(500, 'no validator sent')));
  f._setIcalFetchForTests(t);
  r = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { label: 'not-modified' });
  assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.status, 'not_modified');
  assert.equal(refsOf(u, sid).length, refs.length);
  // the feed drops the one-off event and cancels the moved occurrence: both disappear
  const changed = fx('google-style.ics').replace(/BEGIN:VEVENT\r?\nDTSTART:20251114T060000Z[\s\S]*?END:VEVENT\r?\n/, '').replace('SEQUENCE:2\nSTATUS:CONFIRMED', 'SEQUENCE:2\nSTATUS:CANCELLED');
  feedHost(changed); age(u, sid);
  r = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { label: 'changed' });
  assert.equal(r.json.status, 'ok');
  const after = refsOf(u, sid);
  assert.ok(!after.some((x) => x.includes('one-off-004')), 'vanished event swept');
  assert.ok(!after.some((x) => x.endsWith(':20251124T010000Z')), 'cancelled override tombstoned by exact ref');
  assert.ok(after.some((x) => x.endsWith(':20251201T010000Z') === false && x.includes('standup-001')), 'other occurrences stay');
  assert.ok(r.json.removed >= 1);
  const audit = db.prepare("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'connector.sync'").all(u).map((x) => x.detail).join('');
  assert.ok(!audit.includes(TOKEN) && !audit.includes('calendar.google.com'));
});

test('per-user isolation: another user cannot see, sync, option or delete a feed, and rows stay separate', async () => {
  const a = mkUser(); const b = mkUser();
  const sa = await add(a, 'A'); feedHost(fx('google-style.ics'));
  await call(a, 'POST', '/kb/calendar-ical/sync', { sourceId: sa }, { record: false });
  assert.ok(refsOf(a, sa).length > 0);
  const sb = await add(b, 'B', urlFor('b%40example.com', 'private-cccccccccccc'), { record: false });
  assert.deepEqual((await call(b, 'GET', '/kb/calendar-ical/sources', undefined, { record: false })).json.sources.map((s) => s.sourceId), [sb]);
  for (const [m, p, body] of [['POST', '/kb/calendar-ical/sync', { sourceId: sa }], ['POST', '/kb/calendar-ical/options', { sourceId: sa, options: { daysBack: 5 } }], ['DELETE', `/kb/calendar-ical/sources/${sa}`, undefined]]) {
    const r = await call(b, m, p, body, { record: p.endsWith('options') ? true : false, label: 'other-users-source' });
    assert.equal(r.status, 404, `${m} ${p}`); assert.equal(r.json.error.code, 'ICAL_NOT_FOUND');
  }
  assert.ok(refsOf(a, sa).length > 0);
  assert.equal(vault.getSecret(db, a, `ical.src.${sa}.url`), GOOD);
  assert.equal(vault.getSecret(db, b, `ical.src.${sa}.url`), null);
  assert.equal(refsOf(b, sa).length, 0);
});

test('errors: revoked, rate limit, server error, not a feed, too large, host no longer allowed, missing vault URL', async () => {
  const u = mkUser();
  const sid = await add(u, 'E');
  const sync = (label) => call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { label });
  feedHost(fx('google-style.ics')); await sync();
  const before = refsOf(u, sid).length;
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(404, 'gone')));
  let r = await sync('revoked');
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'ICAL_FEED_REVOKED');
  let st = (await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { label: 'revoked' })).json.sources[0];
  assert.deepEqual([st.status, st.lastError], ['revoked', 'ICAL_FEED_REVOKED']);
  assert.equal(refsOf(u, sid).length, before, 'a revoked feed keeps what it indexed');
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(429, 'slow')));
  r = await sync('rate-limited'); assert.equal(r.status, 429); assert.equal(r.json.error.code, 'ICAL_RATE_LIMITED');
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(503, 'down')));
  r = await sync('fetch-failed'); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'ICAL_FETCH_FAILED');
  feedHost('<html>Sign in to continue</html>');
  r = await sync('parse-failed'); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'ICAL_PARSE_FAILED');
  st = (await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { record: false })).json.sources[0];
  assert.deepEqual([st.status, st.lastError], ['error', 'ICAL_PARSE_FAILED']);
  assert.equal(refsOf(u, sid).length, before, 'a failed run never empties the index');
  f._setIcalFetchForTests(makeTransport().on(() => true, () => textResponse(200, 'x', { 'content-length': String(9 * 1024 * 1024) })));
  r = await sync('too-large'); assert.equal(r.status, 502); assert.equal(r.json.error.code, 'ICAL_TOO_LARGE');
  // a successful run clears the error
  feedHost(fx('google-style.ics')); r = await sync(); assert.equal(r.status, 200);
  st = (await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { record: false })).json.sources[0];
  assert.deepEqual([st.status, st.lastError], ['idle', null]);
  // operator host list shrinks
  db.prepare("UPDATE ical_sources SET host = 'cal.example.org' WHERE user_id = ?").run(u);
  vault.setSecret(db, u, `ical.src.${sid}.url`, 'https://cal.example.org/me.ics');
  r = await sync('host-not-allowed'); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'ICAL_HOST_NOT_ALLOWED');
  vault.setSecret(db, u, `ical.src.${sid}.url`, '');
  r = await sync('url-missing'); assert.equal(r.status, 400); assert.equal(r.json.error.code, 'ICAL_URL_INVALID');
  for (const x of exchanges) assert.ok(!JSON.stringify(x.response).includes(TOKEN), 'no response carries the secret');
});

test('hostile feeds: huge RRULE, nested, 10 MB, binary; bidi and HTML in notes', async () => {
  const u = mkUser();
  const sid = await add(u, 'H');
  const sync = (label) => call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { label, record: false });
  feedHost(fx('hostile-rrule.ics'));
  const t0 = Date.now();
  let r = await sync(); assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(r.json.warnings.includes('rrule_subdaily'));
  feedHost(fx('nested.ics')); age(u, sid); r = await sync(); assert.equal(r.status, 200);
  assert.deepEqual(rows(u, sid).map((x) => x.title), ['Outer event']);
  f._setIcalFetchForTests(makeTransport().on(() => true, () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(1024 * 1024)); c.close(); } }), { status: 200 })));
  r = await sync(); assert.equal(r.json.error.code, 'ICAL_TOO_LARGE');
  feedHost(Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 167 + 13) % 256)).toString('latin1'));
  r = await sync(); assert.equal(r.json.error.code, 'ICAL_PARSE_FAILED');
  const rlo = String.fromCodePoint(0x202e);
  feedHost(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:inj\r\nDTSTART:20251112T010000Z\r\nSUMMARY:Invoice ${rlo}gnp.exe\r\nDESCRIPTION:![x](http://evil.example/p.png) <img src=http://evil.example/t.gif> <script>alert(1)</script>\\nreal text\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`);
  age(u, sid); r = await sync(); assert.equal(r.status, 200);
  const body = rows(u, sid).find((x) => x.title === 'Invoice gnp.exe').body;
  assert.ok(!body.includes(rlo)); assert.ok(!/<img|<script/i.test(body)); assert.ok(!body.includes('![x]('));
  assert.match(body, /real text/);
});

test('options: validated and clamped; a change resets the cursor; the window drives what is indexed', async () => {
  const u = mkUser();
  const sid = await add(u, 'O');
  let r = await call(u, 'POST', '/kb/calendar-ical/options', { sourceId: sid, options: 'x' }, { record: false });
  assert.equal(r.status, 400);
  r = await call(u, 'POST', '/kb/calendar-ical/options', { sourceId: 'zz', options: {} }, { label: 'bad-source-id' });
  assert.equal(r.status, 400);
  r = await call(u, 'POST', '/kb/calendar-ical/options', { sourceId: sid, options: { daysBack: 99999, daysAhead: -4 } });
  assert.deepEqual(r.json, { ok: true, options: { daysBack: 365, daysAhead: 0 } });
  r = await call(u, 'POST', '/kb/calendar-ical/options', { sourceId: sid, options: { daysBack: 0, daysAhead: 7 } });
  feedHost(fx('google-style.ics'));
  r = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { record: false });
  const narrow = r.json.instances;
  await call(u, 'POST', '/kb/calendar-ical/options', { sourceId: sid, options: { daysBack: 30, daysAhead: 90 } }, { record: false });
  r = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { record: false });
  assert.equal(r.json.status, 'ok', 'a changed window is never answered "unchanged"');
  assert.ok(r.json.instances > narrow);
  assert.deepEqual((await call(u, 'GET', '/kb/calendar-ical/sources', undefined, { record: false })).json.sources[0].options, { daysBack: 30, daysAhead: 90 });
});

test('concurrent syncs of one feed: the second is 409 ICAL_SYNC_RUNNING', async () => {
  const u = mkUser();
  const sid = await add(u, 'C');
  let release; const gate = new Promise((res) => { release = res; });
  f._setIcalFetchForTests(makeTransport().on(() => true, async () => { await gate; return textResponse(200, fx('google-style.ics')); }));
  const first = call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { record: false });
  await new Promise((r) => setTimeout(r, 20));
  const second = await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: sid }, { label: 'running' });
  assert.equal(second.status, 409); assert.equal(second.json.error.code, 'ICAL_SYNC_RUNNING');
  release(); assert.equal((await first).status, 200);
});

test('delete: vault row, state, source and cached rows go; other feeds stay', async () => {
  const u = mkUser();
  const keep = await add(u, 'Keep', urlFor('keep%40example.com', 'private-dddddddddddd'), { record: false });
  const sid = await add(u, 'Gone', urlFor('gone%40example.com', 'private-eeeeeeeeeeee'), { record: false });
  feedHost(fx('google-style.ics'));
  for (const id of [keep, sid]) await call(u, 'POST', '/kb/calendar-ical/sync', { sourceId: id }, { record: false });
  const kept = refsOf(u, keep).length;
  const r = await call(u, 'DELETE', `/kb/calendar-ical/sources/${sid}`);
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.ok(r.json.purgedSources > 0);
  assert.equal(refsOf(u, sid).length, 0);
  assert.equal(vault.getSecret(db, u, `ical.src.${sid}.url`), null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM connector_sync_state WHERE user_id = ? AND account_id = ?").get(u, sid).c, 0);
  assert.equal(refsOf(u, keep).length, kept);
  assert.equal((await call(u, 'DELETE', `/kb/calendar-ical/sources/${sid}`, undefined, { label: 'unknown' })).status, 404);
  assert.equal((await call(u, 'DELETE', '/kb/calendar-ical/sources/not-an-id', undefined, { label: 'bad-id' })).status, 400);
});

test('no log line, audit row or response carried a feed URL or token (whole file)', () => {
  const logs = captured.join('');
  assert.ok(!logs.includes(TOKEN), 'secret in captured logs');
  for (const x of exchanges) assert.ok(!JSON.stringify(x.response).includes(TOKEN));
  assert.ok(!JSON.stringify(db.prepare('SELECT detail FROM audit_log').all()).includes(TOKEN));
});

test('route shape: unknown paths and methods fall through', async () => {
  const u = mkUser();
  assert.equal((await call(u, 'GET', '/kb/other', undefined, { record: false })).handled, false);
  assert.equal((await call(u, 'PUT', '/kb/calendar-ical/sources', {}, { record: false })).handled, false);
  assert.equal((await call(u, 'GET', '/kb/calendar-ical/sync', undefined, { record: false })).handled, false);
});
