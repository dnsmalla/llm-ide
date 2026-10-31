// Drive connector (connectors/google/gdrive.mjs), Pattern A: fixtures only, temp DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
const tmpDb = path.join(path.dirname(fileURLToPath(import.meta.url)), '_google-drive-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const gd = await import('../connectors/google/gdrive.mjs');
const gf = await import('../connectors/google/google-fetch.mjs');
const { makeTransport, jsonResponse, textResponse, installTripwire, fixture, fixtureText } = await import('./helpers/google-fixture.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `drv-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'd' }).id;
const session = { ensure: async () => 'TOKEN', refresh: async () => 'TOKEN' };
const sleepImpl = async () => {};
const ACCT = 'abc123abc123';
const NOW = Date.parse('2025-11-01T00:00:00Z');

let tripwire;
before(() => { tripwire = installTripwire(); });
after(() => { gf._setGoogleFetchForTests(null); tripwire.restore(); assert.deepEqual(tripwire.hits, []); kb.closeDb(); for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } } });

const rows = (userId) => db.prepare("SELECT ref, chunk_idx, title, body, meta FROM sources WHERE user_id = ? AND kind = 'doc' AND ref LIKE 'gdrive:%' ORDER BY ref, chunk_idx").all(userId);
const refsOf = (userId) => [...new Set(rows(userId).map((r) => r.ref.split(':')[2]))].sort();
const bodyOf = (userId, id) => rows(userId).filter((r) => r.ref.endsWith(`:${id}`)).map((r) => r.body).join('\n');
const metaOf = (userId, id) => JSON.parse(rows(userId).find((r) => r.ref.endsWith(`:${id}`)).meta);
const TICK = { folderIds: ['folderTick1'] };

function drive({ changes } = {}) {
  const t = makeTransport();
  t.on('/drive/v3/changes/startPageToken', () => jsonResponse(200, fixture('gdrive/start_token.json')));
  t.on('/drive/v3/changes', (u) => (changes ? changes(u) : jsonResponse(200, fixture('gdrive/changes_1.json'))));
  t.on((u) => u.pathname === '/drive/v3/files', (u) => (u.searchParams.get('pageToken') === 'FP2' ? jsonResponse(200, fixture('gdrive/files_2.json')) : jsonResponse(200, fixture('gdrive/files_1.json'))));
  t.on('/drive/v3/files/folderTick1', () => jsonResponse(200, { id: 'folderTick1', name: 'Project', parents: ['rootFolder1'] }));
  t.on('/drive/v3/files/otherFolder1', () => jsonResponse(200, fixture('gdrive/folder_other.json')));
  t.on('/drive/v3/files/rootFolder1', () => jsonResponse(200, fixture('gdrive/folder_root.json')));
  t.on('/drive/v3/files/docInTicked1/export', (u) => textResponse(200, fixtureText('gdrive/export_doc.md'), { 'x-mime': u.searchParams.get('mimeType') }));
  t.on('/drive/v3/files/sheetTicked1/export', () => textResponse(200, fixtureText('gdrive/export_sheet.csv')));
  gf._setGoogleFetchForTests(t);
  return t;
}

test('options are validated and clamped', () => {
  const o = gd.normalizeDriveOptions({ folderIds: ['folderTick1', 'bad id!', 'x'], includeSharedDrives: 'yes' });
  assert.deepEqual(o, { folderIds: ['folderTick1'], includeSharedDrives: false });
});

test('metadata-only scope: bootstrap lists files, writes a findable note per file, never exports content, skips shared drives, no folder rows', async () => {
  const userId = mkUser();
  const t = drive();
  const r = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: TICK, contentGranted: false, now: NOW, sleepImpl });
  assert.equal(r.mode, 'bootstrap'); assert.equal(r.pending, false);
  assert.deepEqual(JSON.parse(r.nextCursor), { startToken: 'T100' }, 'the start token read before listing');
  assert.deepEqual(refsOf(userId), ['docInTicked1', 'docOutside1', 'pdfTicked01', 'sheetTicked1']);
  assert.equal(r.stats.skippedShared, 1);
  assert.ok(!t.calls.some((c) => /\/export$/.test(c.path) || c.query.get('alt') === 'media'), 'no content is read without drive.readonly');
  const m = metaOf(userId, 'docInTicked1');
  assert.equal(m.untrusted, true); assert.equal(m.content, false); assert.equal(m.path, 'My Drive/Project');
  assert.match(bodyOf(userId, 'docInTicked1'), /Type: application\/vnd\.google-apps\.document/);
  assert.ok(t.calls.every((c) => c.host === 'www.googleapis.com' && c.path.startsWith('/drive/v3/')));
  assert.deepEqual(t.unmatched, []);
});

test('content for ticked folders only, with drive.readonly: Docs markdown (images, data: and HTML neutralised, secrets redacted), Sheets as CSV, PDFs metadata-only, other folders metadata-only', async () => {
  const userId = mkUser();
  const t = drive();
  const r = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: TICK, contentGranted: true, now: NOW, sleepImpl });
  assert.equal(r.stats.withContent, 2);
  const doc = bodyOf(userId, 'docInTicked1');
  assert.match(doc, /Body text/);
  for (const bad of ['data:image', 'AAAAAAAA', 'tracker.example.com', 'sk-ant-abcdefghijklmnop123456']) assert.ok(!doc.includes(bad), bad);
  assert.ok(!/(^|[^\\])<script/.test(doc), 'raw HTML neutralised');
  assert.match(doc, /\[image omitted\]/);
  assert.equal(metaOf(userId, 'docInTicked1').content, true);
  assert.match(bodyOf(userId, 'sheetTicked1'), /```csv\na,b\n1,2\n```/);
  assert.match(bodyOf(userId, 'sheetTicked1'), /first sheet only/);
  assert.equal(metaOf(userId, 'pdfTicked01').content, false);
  assert.equal(metaOf(userId, 'docOutside1').content, false);
  const exports = t.calls.filter((c) => /\/export$/.test(c.path));
  assert.deepEqual(exports.map((c) => c.path.split('/')[4]).sort(), ['docInTicked1', 'sheetTicked1']);
  assert.equal(exports.find((c) => c.path.includes('docInTicked1')).query.get('mimeType'), 'text/markdown');
  assert.equal(exports.find((c) => c.path.includes('sheetTicked1')).query.get('mimeType'), 'text/csv');
  assert.ok(!t.calls.some((c) => /docs\.google\.com|tracker/.test(c.host)), 'no webViewLink or content URL is fetched');
});

test('content without a ticked folder, or ticked but not granted, is never read', async () => {
  const userId = mkUser();
  const t1 = drive();
  await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: {}, contentGranted: true, now: NOW, sleepImpl });
  assert.equal(t1.calls.filter((c) => /\/export$/.test(c.path)).length, 0);
  const t2 = drive();
  await gd.syncDrive({ session, userId: mkUser(), accountId: ACCT, cursor: null, options: TICK, contentGranted: false, now: NOW, sleepImpl });
  assert.equal(t2.calls.filter((c) => /\/export$/.test(c.path)).length, 0);
});

test('export fallback and caps: Docs markdown unsupported falls back to text/plain; a response over the cap keeps the metadata note with a marker', async () => {
  const userId = mkUser();
  const t = drive();
  t.routes.unshift({ match: (u) => u.pathname.endsWith('/docInTicked1/export'), reply: (u) => (u.searchParams.get('mimeType') === 'text/markdown' ? jsonResponse(400, { error: { errors: [{ reason: 'exportFormatNotSupported' }] } }) : textResponse(200, 'plain fallback text')) });
  await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: TICK, contentGranted: true, now: NOW, sleepImpl });
  assert.match(bodyOf(userId, 'docInTicked1'), /plain fallback text/);
  const u2 = mkUser();
  const t2 = drive();
  t2.routes.unshift({ match: (u) => u.pathname.endsWith('/docInTicked1/export'), reply: () => new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } }) });
  await gd.syncDrive({ session, userId: u2, accountId: ACCT, cursor: null, options: TICK, contentGranted: true, now: NOW, sleepImpl });
  assert.match(bodyOf(u2, 'docInTicked1'), /larger than the size limit/); assert.equal(metaOf(u2, 'docInTicked1').content, false);
  // text kept is capped
  const u3 = mkUser();
  const t3 = drive();
  t3.routes.unshift({ match: (u) => u.pathname.endsWith('/docInTicked1/export'), reply: () => textResponse(200, 'word '.repeat(200_000)) });
  await gd.syncDrive({ session, userId: u3, accountId: ACCT, cursor: null, options: TICK, contentGranted: true, now: NOW, sleepImpl, limits: {} });
  const total = rows(u3).filter((r) => r.ref.endsWith(':docInTicked1')).reduce((a, r) => a + r.body.length, 0);
  assert.ok(total < 260_000, `kept ${total}`);
});

test('changes feed: cursor is the stored token, removed and trashed files are deleted (tombstones), updates replace, new start token saved', async () => {
  const userId = mkUser();
  drive();
  const first = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: TICK, contentGranted: true, now: NOW, sleepImpl });
  const t = drive();
  const r = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: first.nextCursor, options: TICK, contentGranted: true, now: NOW, sleepImpl });
  assert.equal(r.mode, 'changes');
  assert.deepEqual(JSON.parse(r.nextCursor), { startToken: 'T200' });
  assert.equal(t.callsTo('/changes')[0].query.get('pageToken'), 'T100');
  assert.equal(t.callsTo('/changes')[0].query.get('includeRemoved'), 'true');
  assert.equal(r.stats.removed, 2);
  assert.deepEqual(refsOf(userId), ['docInTicked1', 'pdfTicked01']);
  assert.match(rows(userId).find((x) => x.ref.endsWith(':docInTicked1')).title, /v2/);
});

test('invalid page token: bounded re-bootstrap, rows not seen again are dropped only after the pass finished', async () => {
  const userId = mkUser();
  drive();
  await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: TICK, contentGranted: false, now: NOW, sleepImpl });
  db.prepare("INSERT INTO sources (user_id, kind, ref, chunk_idx, title, body, meta, indexed_at) VALUES (?, 'doc', ?, 0, 'old', 'old', '{}', '2000-01-01 00:00:00')").run(userId, `gdrive:${ACCT}:stale000001`);
  const t = drive({ changes: () => jsonResponse(404, { error: { errors: [{ reason: 'notFound' }] } }) });
  const r = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: JSON.stringify({ startToken: 'OLD' }), options: TICK, contentGranted: false, now: Date.now(), sleepImpl });
  assert.equal(r.stats.restarted, true); assert.equal(r.mode, 'bootstrap');
  assert.deepEqual(JSON.parse(r.nextCursor), { startToken: 'T100' });
  assert.ok(!refsOf(userId).includes('stale000001'));
  assert.equal(t.callsTo('startPageToken').length, 1);
});

test('run cap: bootstrap resumes from its page token and finishes without losing files', async () => {
  const userId = mkUser();
  drive();
  const r1 = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: null, options: TICK, contentGranted: false, now: NOW, sleepImpl, limits: { maxFilesPerRun: 1 } });
  assert.equal(r1.pending, true);
  const c1 = JSON.parse(r1.nextCursor);
  assert.equal(c1.bootstrap.pageToken, 'FP2'); assert.equal(c1.startToken, 'T100');
  const r2 = await gd.syncDrive({ session, userId, accountId: ACCT, cursor: r1.nextCursor, options: TICK, contentGranted: false, now: NOW + 3000, sleepImpl });
  assert.equal(r2.pending, false);
  assert.deepEqual(refsOf(userId), ['docInTicked1', 'docOutside1', 'pdfTicked01', 'sheetTicked1']);
});

test('shared drives: off by default (params and rows), on when the option is set', async () => {
  const u1 = mkUser();
  const t1 = drive();
  await gd.syncDrive({ session, userId: u1, accountId: ACCT, cursor: null, options: {}, contentGranted: false, now: NOW, sleepImpl });
  assert.equal(t1.callsTo('/drive/v3/files').find((c) => c.path === '/drive/v3/files').query.get('includeItemsFromAllDrives'), 'false');
  assert.ok(!refsOf(u1).includes('sharedFile1'));
  const u2 = mkUser();
  const t2 = drive();
  await gd.syncDrive({ session, userId: u2, accountId: ACCT, cursor: null, options: { includeSharedDrives: true }, contentGranted: false, now: NOW, sleepImpl });
  assert.equal(t2.callsTo('/drive/v3/files').find((c) => c.path === '/drive/v3/files').query.get('includeItemsFromAllDrives'), 'true');
  assert.ok(refsOf(u2).includes('sharedFile1'));
  assert.equal(metaOf(u2, 'sharedFile1').sharedDrive, true);
});

test('per-user isolation and error handling: no cross-user rows; malformed JSON and 5xx give stable codes without body text', async () => {
  const u1 = mkUser(); const u2 = mkUser();
  drive();
  await gd.syncDrive({ session, userId: u1, accountId: ACCT, cursor: null, options: {}, contentGranted: false, now: NOW, sleepImpl });
  assert.equal(rows(u2).length, 0);
  gf._setGoogleFetchForTests(makeTransport().on(() => true, () => new Response('{"files":', { status: 200 })));
  await assert.rejects(() => gd.syncDrive({ session, userId: u2, accountId: ACCT, cursor: JSON.stringify({ startToken: 'T' }), options: {}, contentGranted: false, sleepImpl }), (e) => e.code === 'GOOGLE_BAD_JSON');
  gf._setGoogleFetchForTests(makeTransport().on(() => true, () => jsonResponse(500, { error: { message: 'LEAK ya29.LEAKLEAKLEAKLEAKLEAKLEAK' } })));
  await assert.rejects(() => gd.syncDrive({ session, userId: u2, accountId: ACCT, cursor: JSON.stringify({ startToken: 'T' }), options: {}, contentGranted: false, sleepImpl }), (e) => !/LEAK/.test(e.message));
});

test('folder and shared-drive pickers use the API by id and return names only', async () => {
  const t = makeTransport();
  t.on('/drive/v3/files', () => jsonResponse(200, { files: [{ id: 'f1', name: 'A' }] }));
  t.on('/drive/v3/drives', () => jsonResponse(200, { drives: [{ id: 'd1', name: 'Team' }] }));
  gf._setGoogleFetchForTests(t);
  assert.deepEqual(await gd.listFolders({ session, parentId: "x' or '1'='1", sleepImpl }), [{ id: 'f1', name: 'A' }]);
  assert.match(t.calls[0].query.get('q'), /^'root' in parents/, 'an unsafe parent id never reaches the query');
  assert.deepEqual(await gd.listSharedDrives({ session, sleepImpl }), [{ id: 'd1', name: 'Team' }]);
});
