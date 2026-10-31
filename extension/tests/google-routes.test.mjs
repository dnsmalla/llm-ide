// /kb/google/* routes (routes/google-connectors.mjs): in-process req/res doubles, the real handler, the real loopback
// listener, a fixture transport in place of Google. Set GOOGLE_DUMP_FIXTURES=<dir> to write every exchange as a contract
// fixture (schema/http/fixtures/google) with the nondeterministic values normalised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_google-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');
const { handleGoogleRoutes } = await import('../routes/google-connectors.mjs');
const auth = await import('../connectors/google/google-auth.mjs');
const gf = await import('../connectors/google/google-fetch.mjs');
const store = await import('../kb/google-store.mjs');
const { makeTransport, jsonResponse, textResponse, makeIdToken, installTripwire, fixture, fixtureText } = await import('./helpers/google-fixture.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `gr-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'g' }).id;
const REFRESH = '1//0gROUTE-REFRESH-TOKEN-0123456789abcdefghij';
const ACCESS = 'ya29.ROUTE-ACCESS-TOKEN-0123456789abcdefghij';
const SECRET = 'GOCSPX-route-client-secret-0123456789';

let tripwire;
before(() => { tripwire = installTripwire(); gf._setGoogleSleepForTests(async () => {}); });
after(() => {
  gf._setGoogleFetchForTests(null); gf._setGoogleSleepForTests(null); auth._resetGoogleAuthForTests(); tripwire.restore();
  assert.deepEqual(tripwire.hits, []); kb.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
  if (process.env.GOOGLE_DUMP_FIXTURES) dump(process.env.GOOGLE_DUMP_FIXTURES);
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
  const handled = await handleGoogleRoutes(req, res, { userId, url });
  if (!handled) return { handled: false };
  const json = res._body ? JSON.parse(res._body) : null;
  if (record) {
    const u = new URL(url, 'http://x');
    const request = {};
    if ([...u.searchParams].length) request.query = Object.fromEntries(u.searchParams);
    if (body !== undefined) request.body = body;
    exchanges.push({ method, path: u.pathname, status: res.statusCode, request, response: json, label });
  }
  return { handled: true, status: res.statusCode, json };
}

function dump(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const norm = (v, k) => {
    if (k === 'authUrl') return 'https://accounts.google.com/o/oauth2/v2/auth?client_id=example-client-id.apps.googleusercontent.com&response_type=code&state=EXAMPLE_STATE';
    if (k === 'state') return 'EXAMPLE_STATE';
    if (k === 'redirectPort') return 54321;
    if (k === 'batchId') return '0123456789abcdef01234567';
    if (k === 'accountId') return typeof v === 'string' && /^[a-f0-9]{12}$/.test(v) ? '0123456789ab' : v;
    if (k === 'lastRunAt') return '2025-11-01T00:00:00.000Z';
    if (k === 'email') return 'me@example.com';
    if (k === 'clientSecret') return 'example-client-secret';
    if (k === 'clientId') return 'example-client-id.apps.googleusercontent.com';
    return v;
  };
  const walk = (x, k) => (Array.isArray(x) ? x.map((e) => walk(e, k)) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([kk, vv]) => [kk, walk(vv, kk)])) : norm(x, k));
  const seen = new Map();
  for (const e of exchanges) {
    const base = `${e.method.toLowerCase()}${e.path.replace(/\//g, '-')}-${e.status}`;
    const c = (seen.get(base) || 0) + 1; seen.set(base, c);
    const name = e.label ? `${base}-${e.label}` : (c > 1 ? `${base}-${c}` : base);
    const fx = { endpoint: `${e.method} ${e.path}`, status: e.status };
    if (Object.keys(e.request).length) fx.request = walk(e.request, '');
    if (e.response !== null) fx.response = walk(e.response, '');
    fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(fx, null, 2)}\n`);
  }
}

function loopback(port, query) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/oauth2/callback?${query}` }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
  });
}

/** Connect an account through the real routes: start, loopback callback, status. Grants exactly what was requested. */
async function connect(userId, products, { driveContent = false, sub = 'sub-r', email = 'me@example.com', t = makeTransport(), record = false } = {}) {
  let nonce; let requested;
  t.routes.unshift({ match: (u) => u.pathname === '/token', reply: (u, i, c) => {
    if (c.body.grant_type === 'authorization_code') return jsonResponse(200, { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3599, token_type: 'Bearer', scope: requested, id_token: makeIdToken({ sub, email, aud: c.body.client_id, nonce }) });
    return jsonResponse(200, { access_token: ACCESS, expires_in: 3599, token_type: 'Bearer' });
  } });
  t.on('/revoke', () => jsonResponse(200, {}));
  gf._setGoogleFetchForTests(t);
  const s = await call(userId, 'POST', '/kb/google/start', { clientId: 'example-client-id.apps.googleusercontent.com', clientSecret: SECRET, products, driveContent }, { record });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const p = new URL(s.json.authUrl).searchParams;
  nonce = p.get('nonce'); requested = p.get('scope');
  assert.equal(await loopback(s.json.redirectPort, `state=${s.json.state}&code=x`), 200);
  const st = await call(userId, 'GET', `/kb/google/status?state=${s.json.state}`, undefined, { record });
  assert.equal(st.json.status, 'complete', JSON.stringify(st.json));
  return { accountId: st.json.accountId, transport: t, start: s.json };
}

const scan = (obj) => { const j = JSON.stringify(obj); for (const x of [REFRESH, ACCESS, SECRET]) assert.ok(!j.includes(x), 'secret in response'); };

test('start validation: products, client, account id, body shape', async () => {
  const u = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  let r = await call(u, 'POST', '/kb/google/start', { clientId: 'c', clientSecret: 's', products: [] }, { label: 'no-products' });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'GOOGLE_BAD_REQUEST');
  r = await call(u, 'POST', '/kb/google/start', { clientId: 'c', clientSecret: 's' }, { label: 'products-not-a-list' });
  assert.equal(r.status, 400); assert.equal(r.json.error.code, 'VALIDATION_FAILED');
  r = await call(u, 'POST', '/kb/google/start', { products: ['gmail'] }, { label: 'no-client' });
  assert.equal(r.status, 400);
  r = await call(u, 'POST', '/kb/google/start', { clientId: 'c', clientSecret: 's', products: ['gmail'], accountId: 'nope' }, { label: 'bad-account-id' });
  assert.equal(r.status, 400);
  r = await call(u, 'POST', '/kb/google/start', { clientId: 5, products: ['gmail'] }, { label: 'client-not-a-string' });
  assert.equal(r.status, 400);
  r = await call(u, 'POST', '/kb/google/start', { clientId: 'c', clientSecret: 's', products: ['gmail'], accountId: '0123456789ab' }, { label: 'unknown-account' });
  assert.equal(r.status, 404, 'unknown account for an upgrade');
  assert.equal((await call(u, 'POST', '/kb/google/nothing', {})).handled, false);
});

test('connect through the routes: start, loopback, status; accounts shows no secret; the flow status is read once', async () => {
  const u = mkUser();
  const { accountId, start } = await connect(u, ['gmail', 'gcal'], { record: true });
  assert.match(accountId, /^[a-f0-9]{12}$/);
  assert.ok(start.scopes.every((s) => s.readOnly === true));
  assert.equal(start.legacyMailTokenRevoked, false);
  const again = await call(u, 'GET', `/kb/google/status?state=${start.state}`, undefined, { label: 'unknown' });
  assert.deepEqual(again.json, { status: 'unknown' });
  const acc = await call(u, 'GET', '/kb/google/accounts');
  assert.equal(acc.status, 200); scan(acc.json);
  const a = acc.json.accounts[0];
  assert.equal(a.accountId, accountId); assert.deepEqual(a.products.sort(), ['gcal', 'gmail']); assert.equal(a.email, 'me@example.com');
  assert.deepEqual(a.connectors.gmail.options, { labels: ['INBOX'], windowDays: 30, includePromotions: false, includeSocial: false });
  assert.equal(acc.json.legacyMailToken, false);
});

test('status: another user gets 403, a pending flow is pending, unknown state is unknown', async () => {
  const u1 = mkUser(); const u2 = mkUser();
  gf._setGoogleFetchForTests(makeTransport());
  const s = await call(u1, 'POST', '/kb/google/start', { clientId: 'c', clientSecret: SECRET, products: ['gmail'] }, { record: false });
  const pending = await call(u1, 'GET', `/kb/google/status?state=${s.json.state}`, undefined, { label: 'pending' });
  assert.deepEqual(pending.json, { status: 'pending' });
  const foreign = await call(u2, 'GET', `/kb/google/status?state=${s.json.state}`, undefined, { label: 'forbidden' });
  assert.equal(foreign.status, 403);
  auth.abortUserFlows(u1);
  const aborted = await call(u1, 'GET', `/kb/google/status?state=${s.json.state}`, undefined, { label: 'error' });
  assert.equal(aborted.json.status, 'error');
});

test('accounts: per-user isolation; options: validation, normalisation, product gate, drive content flag', async () => {
  const u1 = mkUser(); const u2 = mkUser();
  const { accountId } = await connect(u1, ['gmail', 'gdrive']);
  assert.equal((await call(u2, 'GET', '/kb/google/accounts', undefined, { record: false })).json.accounts.length, 0);
  assert.equal((await call(u2, 'POST', '/kb/google/options', { accountId, product: 'gmail', options: {} }, { label: 'unknown-account' })).status, 404);
  let r = await call(u1, 'POST', '/kb/google/options', { accountId, product: 'gmail', options: { labels: ['INBOX', 'Label_1', 'bad label!'], windowDays: 9999 } });
  assert.equal(r.status, 200); assert.deepEqual(r.json.options, { labels: ['INBOX', 'Label_1'], windowDays: 365, includePromotions: false, includeSocial: false });
  r = await call(u1, 'POST', '/kb/google/options', { accountId, product: 'gdrive', options: { folderIds: ['folderTick1'], includeSharedDrives: true } }, { label: 'drive' });
  assert.equal(r.status, 200); assert.equal(r.json.contentGranted, false); assert.deepEqual(r.json.options.folderIds, ['folderTick1']);
  r = await call(u1, 'POST', '/kb/google/options', { accountId, product: 'gcal', options: {} }, { label: 'not-granted' });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'GOOGLE_PRODUCT_NOT_GRANTED');
  r = await call(u1, 'POST', '/kb/google/options', { accountId, product: 'mail', options: {} }, { label: 'bad-product' });
  assert.equal(r.status, 400);
  r = await call(u1, 'POST', '/kb/google/options', { accountId, product: 'gmail', options: [] }, { record: false });
  assert.equal(r.status, 400);
  r = await call(u1, 'POST', '/kb/google/options', { accountId: 'xyz', product: 'gmail', options: {} }, { label: 'bad-account-id' });
  assert.equal(r.status, 400);
  const acc = await call(u1, 'GET', '/kb/google/accounts', undefined, { label: 'with-options' });
  assert.deepEqual(acc.json.accounts[0].connectors.gmail.options.labels, ['INBOX', 'Label_1']);
});

test('gmail: fetch returns notes and a batch; the cursor moves only after seen (create first, then mark seen); replay and unknown batches are refused', async () => {
  const u = mkUser();
  const { accountId, transport } = await connect(u, ['gmail']);
  transport.on('/gmail/v1/users/me/profile', () => jsonResponse(200, fixture('gmail/profile.json')));
  transport.on('/gmail/v1/users/me/threads', () => jsonResponse(200, fixture('gmail/threads_list.json')));
  transport.on((x) => /\/threads\/[^/]+$/.test(x.pathname), (x) => { const id = x.pathname.split('/').pop(); const m = { 't-simple': 'thread_simple', 't-html': 'thread_html', 't-promo': 'thread_promo' }[id]; return m ? jsonResponse(200, fixture(`gmail/${m}.json`)) : jsonResponse(404, {}); });
  transport.on('/gmail/v1/users/me/history', () => jsonResponse(200, { history: [{ id: '1601', messagesDeleted: [{ message: { threadId: 't-gone' } }] }], historyId: '1700' }));
  const f1 = await call(u, 'POST', '/kb/google/gmail/fetch', { accountId });
  assert.equal(f1.status, 200); scan(f1.json);
  assert.equal(f1.json.mode, 'bootstrap'); assert.equal(f1.json.notes.length, 2);
  assert.match(f1.json.notes[0].noteFile, /^gmail-[a-f0-9]{12}-/); assert.match(f1.json.notes[0].markdown, /^---\nsource: "gmail"/);
  assert.equal(store.getSyncState(u, 'gmail', accountId).cursor, null, 'not committed before seen');
  // a second fetch before seen starts from the same place
  const f1b = await call(u, 'POST', '/kb/google/gmail/fetch', { accountId }, { record: false });
  assert.equal(f1b.json.mode, 'bootstrap'); assert.notEqual(f1b.json.batchId, f1.json.batchId);
  // the older batch can no longer be confirmed (only the latest pending batch)
  assert.equal((await call(u, 'POST', '/kb/google/gmail/seen', { accountId, batchId: f1.json.batchId }, { label: 'unknown-batch' })).status, 409);
  assert.equal((await call(u, 'POST', '/kb/google/gmail/seen', { accountId, batchId: 5 }, { record: false })).status, 409);
  const seen = await call(u, 'POST', '/kb/google/gmail/seen', { accountId, batchId: f1b.json.batchId });
  assert.deepEqual(seen.json, { ok: true, pending: false });
  assert.deepEqual(JSON.parse(store.getSyncState(u, 'gmail', accountId).cursor), { historyId: '1000' });
  assert.equal((await call(u, 'POST', '/kb/google/gmail/seen', { accountId, batchId: f1b.json.batchId }, { record: false })).status, 409, 'replay refused');
  const f2 = await call(u, 'POST', '/kb/google/gmail/fetch', { accountId }, { label: 'incremental' });
  assert.equal(f2.json.mode, 'history'); assert.equal(f2.json.notes.length, 0); assert.equal(f2.json.tombstones.length, 1);
  assert.equal(transport.callsTo('/history')[0].query.get('startHistoryId'), '1000');
  const acc = await call(u, 'GET', '/kb/google/accounts', undefined, { record: false });
  assert.equal(acc.json.accounts[0].connectors.gmail.status, 'idle');
  // product gate: a calendar sync on a gmail-only account is refused
  assert.equal((await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' }, { record: false })).status, 409);
  assert.equal((await call(u, 'POST', '/kb/google/gmail/fetch', {}, { label: 'no-account' })).status, 400);
});

test('calendar and drive sync routes, pickers, and options persist; sync state and status update', async () => {
  const u = mkUser();
  const t = makeTransport();
  const { accountId } = await connect(u, ['gcal', 'gdrive'], { driveContent: true, t });
  t.on((x) => x.pathname.endsWith('/events'), (x) => jsonResponse(200, x.searchParams.get('pageToken') === 'PG2' ? fixture('gcal/events_full_2.json') : fixture('gcal/events_full_1.json')));
  t.on('/calendar/v3/users/me/calendarList', () => jsonResponse(200, fixture('gcal/calendar_list.json')));
  t.on('/drive/v3/changes/startPageToken', () => jsonResponse(200, fixture('gdrive/start_token.json')));
  t.on((x) => x.pathname === '/drive/v3/files', (x) => (x.searchParams.get('q')?.includes('in parents') ? jsonResponse(200, { files: [{ id: 'folderTick1', name: 'Project' }] }) : x.searchParams.get('pageToken') === 'FP2' ? jsonResponse(200, fixture('gdrive/files_2.json')) : jsonResponse(200, fixture('gdrive/files_1.json'))));
  t.on('/drive/v3/files/folderTick1', () => jsonResponse(200, { id: 'folderTick1', name: 'Project', parents: ['rootFolder1'] }));
  t.on('/drive/v3/files/otherFolder1', () => jsonResponse(200, fixture('gdrive/folder_other.json')));
  t.on('/drive/v3/files/rootFolder1', () => jsonResponse(200, fixture('gdrive/folder_root.json')));
  t.on('/drive/v3/files/docInTicked1/export', () => textResponse(200, fixtureText('gdrive/export_doc.md')));
  t.on('/drive/v3/files/sheetTicked1/export', () => textResponse(200, fixtureText('gdrive/export_sheet.csv')));

  const cals = await call(u, 'GET', '/kb/google/calendars?accountId=' + accountId);
  assert.equal(cals.status, 200); assert.equal(cals.json.calendars.length, 2);
  const folders = await call(u, 'GET', '/kb/google/drive/folders?accountId=' + accountId);
  assert.deepEqual(folders.json, { folders: [{ id: 'folderTick1', name: 'Project' }] });
  assert.equal((await call(u, 'GET', '/kb/google/calendars?accountId=0123456789ab', undefined, { label: 'unknown-account' })).status, 404);

  await call(u, 'POST', '/kb/google/options', { accountId, product: 'gdrive', options: { folderIds: ['folderTick1'] } }, { record: false });
  const cal = await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' });
  assert.equal(cal.status, 200); assert.equal(cal.json.events, 3); assert.equal(cal.json.pending, false);
  assert.deepEqual(JSON.parse(store.getSyncState(u, 'gcal', accountId).cursor), { cals: { primary: { syncToken: 'SYNC1' } } });
  const drv = await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gdrive' }, { label: 'drive' });
  assert.equal(drv.status, 200); assert.equal(drv.json.mode, 'bootstrap'); assert.equal(drv.json.stats.withContent, 2);
  assert.deepEqual(JSON.parse(store.getSyncState(u, 'gdrive', accountId).cursor), { startToken: 'T100' });
  assert.equal((await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gmail' }, { label: 'bad-product' })).status, 400);
  assert.equal((await call(u, 'POST', '/kb/google/gmail/fetch', { accountId }, { label: 'not-granted' })).status, 409);
  const acc = await call(u, 'GET', '/kb/google/accounts', undefined, { record: false });
  assert.equal(acc.json.accounts[0].connectors.gcal.status, 'idle'); assert.ok(acc.json.accounts[0].connectors.gcal.lastRunAt);
  assert.equal(acc.json.accounts[0].driveContent, true);
  const audit = db.prepare("SELECT action, resource, detail FROM audit_log WHERE user_id = ? AND action = 'connector.sync'").all(u);
  assert.equal(audit.length, 2); scan(audit);
  assert.ok(audit.every((a) => !/summary|Dentist|Design/.test(a.detail)), 'counts only, no content in audit');
});

test('a sync already running for the account is refused with 409', async () => {
  const u = mkUser();
  const t = makeTransport();
  const { accountId } = await connect(u, ['gcal'], { t });
  let release; const gate = new Promise((r) => { release = r; });
  t.on((x) => x.pathname.endsWith('/events'), async () => { await gate; return jsonResponse(200, fixture('gcal/events_full_2.json')); });
  const first = call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' }, { record: false });
  await new Promise((r) => setTimeout(r, 30));
  const second = await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' }, { label: 'running' });
  assert.equal(second.status, 409); assert.equal(second.json.error.code, 'GOOGLE_SYNC_RUNNING');
  release();
  assert.equal((await first).status, 200);
});

test('a dead grant: invalid_grant marks reconnect_needed (409), later calls make no network request, accounts shows it', async () => {
  const u = mkUser();
  const t = makeTransport();
  const { accountId } = await connect(u, ['gcal'], { t });
  // expire the cached token path by forcing a refresh, and kill the grant
  t.routes.unshift({ match: (x) => x.pathname === '/token', reply: () => jsonResponse(400, { error: 'invalid_grant', error_description: `x ${REFRESH}` }) });
  t.on((x) => x.pathname.endsWith('/events'), () => jsonResponse(401, {}));
  const r = await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' }, { label: 'reconnect' });
  assert.equal(r.status, 409); assert.equal(r.json.error.code, 'GOOGLE_RECONNECT_NEEDED'); scan(r.json);
  const before = t.calls.length;
  const r2 = await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' }, { record: false });
  assert.equal(r2.status, 409); assert.equal(t.calls.length, before, 'no network call for a dead account');
  const acc = await call(u, 'GET', '/kb/google/accounts', undefined, { label: 'reconnect-needed' });
  assert.equal(acc.json.accounts[0].status, 'reconnect_needed'); assert.equal(acc.json.accounts[0].connectors.gcal.status, 'reconnect_needed');
});

test('upstream failures answer 502/429 with a stable code and never the body or a token', async () => {
  const u = mkUser();
  const t = makeTransport();
  const { accountId } = await connect(u, ['gcal'], { t });
  t.on((x) => x.pathname.endsWith('/events'), () => jsonResponse(500, { error: { message: `boom ${ACCESS} ${REFRESH}` } }));
  const r = await call(u, 'POST', '/kb/google/sync', { accountId, product: 'gcal' }, { record: false });
  assert.ok([502, 429].includes(r.status)); scan(r.json);
  assert.ok(/^GOOGLE_/.test(r.json.error.code));
  assert.match(store.getSyncState(u, 'gcal', accountId).status, /error/);
});

test('upgrade to drive content: a second start for the account requests the union of scopes and keeps products', async () => {
  const u = mkUser();
  const t = makeTransport();
  const { accountId } = await connect(u, ['gdrive', 'gcal'], { t });
  const s = await call(u, 'POST', '/kb/google/start', { products: ['gdrive'], driveContent: true, accountId }, { record: false });
  assert.equal(s.status, 200);
  const sc = new URL(s.json.authUrl).searchParams.get('scope').split(' ');
  assert.ok(sc.includes('https://www.googleapis.com/auth/drive.readonly'));
  assert.ok(sc.includes('https://www.googleapis.com/auth/calendar.events.readonly'), 'existing products kept');
  assert.equal(new URL(s.json.authUrl).searchParams.get('client_id'), 'example-client-id.apps.googleusercontent.com', 'the account client is reused, no secret asked again');
  auth.abortUserFlows(u);
});

test('legacy mail.google.com token: accounts reports it; the first connect revokes it and says so', async () => {
  const u = mkUser();
  setSecret(db, u, 'google.email.refreshToken', '1//0gLEGACY-TOKEN-0123456789abcdefghijklmn');
  gf._setGoogleFetchForTests(makeTransport());
  assert.equal((await call(u, 'GET', '/kb/google/accounts', undefined, { label: 'legacy' })).json.legacyMailToken, true);
  const { start, transport } = await connect(u, ['gmail'], { record: false });
  assert.equal(start.legacyMailTokenRevoked, true);
  assert.equal(transport.callsTo('/revoke').length, 1);
  assert.equal((await call(u, 'GET', '/kb/google/accounts', undefined, { record: false })).json.legacyMailToken, false);
  const s = await call(u, 'POST', '/kb/google/start', { clientId: 'c', clientSecret: SECRET, products: ['gmail'] }, { record: true, label: 'legacy-revoked' });
  assert.equal(s.json.legacyMailTokenRevoked, false);
  auth.abortUserFlows(u);
});

test('disconnect: revoke, credentials and cursors gone, accounts empty; unknown account 404; another user 404', async () => {
  const u = mkUser(); const other = mkUser();
  const { accountId, transport } = await connect(u, ['gmail']);
  assert.equal((await call(other, 'POST', '/kb/google/disconnect', { accountId }, { record: false })).status, 404);
  assert.equal((await call(u, 'POST', '/kb/google/disconnect', { accountId: '0123456789ab' }, { label: 'unknown' })).status, 404);
  const r = await call(u, 'POST', '/kb/google/disconnect', { accountId });
  assert.deepEqual(r.json, { ok: true, revoked: true, purgedSources: 0 });
  assert.equal(transport.callsTo('/revoke').at(-1).body.token, REFRESH);
  assert.deepEqual((await call(u, 'GET', '/kb/google/accounts', undefined, { record: false })).json.accounts, []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_secrets WHERE user_id = ? AND secret_key LIKE 'google.acct.%'").get(u).n, 0);
  const audit = db.prepare("SELECT detail FROM audit_log WHERE user_id = ? AND action = 'connector.revoke'").all(u);
  assert.equal(audit.length, 1); scan(audit);
  // offline revoke: local credentials still deleted, revoked false
  const c2 = await connect(u, ['gmail'], { sub: 'sub-2' });
  c2.transport.routes.unshift({ match: (x) => x.pathname === '/revoke', reply: () => { throw new TypeError('fetch failed'); } });
  const r2 = await call(u, 'POST', '/kb/google/disconnect', { accountId: c2.accountId }, { label: 'offline' });
  assert.equal(r2.json.revoked, false);
});

test('deleting the user removes accounts, cursors and vault rows (no orphan per-user rows)', async () => {
  const u = mkUser();
  const { accountId } = await connect(u, ['gmail']);
  store.patchSyncState(u, 'gmail', accountId, { cursor: '{"historyId":"1"}' });
  const counts = kb.deleteUserCascade(u);
  assert.equal(counts.google_accounts, 1); assert.equal(counts.connector_sync_state, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM google_accounts WHERE user_id = ?').get(u).n, 0);
});
