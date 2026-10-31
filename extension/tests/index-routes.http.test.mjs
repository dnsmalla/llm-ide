// HTTP-level tests for the note index routes (in-process server, real router):
// the 1 MB body limit (413), the 50-note batch cap, malformed percent-encoding
// (400, never 500), and a normal round trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_index-routes-http-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { startKbServer } = await import('./helpers/kb-http.mjs');
const conn = db.getDb();
const U = users.registerUser(conn, { email: `ihttp-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'h' }).id;
const srv = await startKbServer();
srv.as(U);

test.after(async () => {
  await srv.close();
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const note = (i, extra = {}) => ({ noteKey: `http/${i}.md`, title: `T${i}`, date: '2026-10-29T00:00:00.000Z', contentHash: `h${i}`, body: `body ${i}`, ...extra });

test('a normal batch round-trips: 200 with counts, then status is consistent', async () => {
  const r = await srv.call('POST', '/kb/index/notes', { projectId: 'p1', notes: [note(1), note(2)] });
  assert.equal(r.status, 200);
  assert.equal(r.body.upserted, 2);
  const st = await srv.call('GET', '/kb/index/status?projectId=p1');
  assert.equal(st.status, 200);
  assert.equal(st.body.consistent, true);
  assert.equal(st.body.notes, 2);
});

test('a body over 1 MB is refused with 413 PAYLOAD_TOO_LARGE and nothing is written', async () => {
  // Just over the limit, not far over it: the server refuses at the limit and
  // closes, and bytes still in flight at that moment turn the close into a TCP
  // reset (EPIPE on the client's write) that can swallow the 413. A body that
  // exceeds the limit by a few hundred bytes leaves nothing unread.
  const big = { projectId: 'p-big', notes: [note(9, { body: 'x'.repeat(1024 * 1024) })] };
  const r = await srv.call('POST', '/kb/index/notes', big);
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE project_id = 'p-big'").get().n, 0);
});

test('a batch of 51 notes is refused with 400 BATCH_TOO_LARGE', async () => {
  const notes = Array.from({ length: 51 }, (_, i) => note(100 + i, { noteKey: `batch/${i}.md` }));
  const r = await srv.call('POST', '/kb/index/notes', { projectId: 'p-batch', notes });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'BATCH_TOO_LARGE');
});

test('a malformed percent-escape in the note key path is a 400, not a 500', async () => {
  const r = await srv.call('DELETE', '/kb/index/notes/%E0%A4%A?projectId=p1');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_FAILED');
});

test('a note whose body is over 512 KiB is refused with 400', async () => {
  const r = await srv.call('POST', '/kb/index/notes', { projectId: 'p-fat', notes: [note(7, { body: 'y'.repeat(600 * 1024) })] });
  assert.equal(r.status, 400);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE project_id = 'p-fat'").get().n, 0);
});

test('HTTP: /kb/ingest refuses a meeting id with the reserved note prefix or a control character (400, nothing stored)', async () => {
  const reserved = await srv.call('POST', '/kb/ingest', { id: '\u0001note:1', title: 'x', transcript: 'y', date: '2026-10-29', duration: 1 });
  assert.equal(reserved.status, 400);
  assert.equal(reserved.body.error.code, 'VALIDATION_FAILED');
  const control = await srv.call('POST', '/kb/ingest', { id: 'bad\u0007id', title: 'x', transcript: 'y', date: '2026-10-29', duration: 1 });
  assert.equal(control.status, 400);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM meetings WHERE user_id = ? AND id LIKE '%bad%'").get(U).n, 0);
});

test('GET /kb/index/search: ranked, user-scoped, snippet is sanitised plain text, kinds beyond meeting are indexed', async () => {
  const other = users.registerUser(conn, { email: `ihttp2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'o' }).id;
  const key = 'sk-ant-api03-' + 'k'.repeat(30);
  const put = await srv.call('POST', '/kb/index/notes', { projectId: 'ps', notes: [
    note(201, { noteKey: 'search/a.md', title: 'Quarterly roadmap', kind: 'note', body: `intro\u0007‮ text before. The zebrafish migration plan is here ${key}. <script>alert(1)</script> tail` }),
    note(202, { noteKey: 'search/b.md', title: 'Mail about zebrafish', kind: 'email', body: 'zebrafish' }),
    note(203, { noteKey: 'search/c.md', title: 'Unrelated', kind: 'slack', body: 'nothing here' }),
  ] });
  assert.equal(put.status, 200);
  assert.equal(put.body.upserted, 3);
  const bad = await srv.call('POST', '/kb/index/notes', { projectId: 'ps', notes: [note(204, { kind: 'evil' })] });
  assert.equal(bad.status, 400);

  const r = await srv.call('GET', '/kb/index/search?q=zebrafish&limit=10&projectId=ps');
  assert.equal(r.status, 200);
  const keys = r.body.results.map((x) => x.noteKey).sort();
  assert.deepEqual(keys, ['search/a.md', 'search/b.md']);
  const a = r.body.results.find((x) => x.noteKey === 'search/a.md');
  assert.equal(a.kind, 'note');
  assert.equal(a.title, 'Quarterly roadmap');
  assert.match(a.snippet, /zebrafish migration plan/);
  assert.ok(!a.snippet.includes(key), 'secrets stay redacted');
  assert.ok(!/[\u0000-\u001f‮]/.test(a.snippet), 'no control or bidi characters');
  assert.ok(a.snippet.length <= 202 + 2);
  assert.ok(Date.parse(a.date) > 0);

  // limit caps the rows
  assert.equal((await srv.call('GET', '/kb/index/search?q=zebrafish&limit=1&projectId=ps')).body.results.length, 1);
  // another project / another user sees nothing
  assert.deepEqual((await srv.call('GET', '/kb/index/search?q=zebrafish&projectId=nope')).body.results, []);
  srv.as(other);
  assert.deepEqual((await srv.call('GET', '/kb/index/search?q=zebrafish')).body.results, []);
  srv.as(U);

  // a query with no searchable word returns nothing; bad parameters are 400
  assert.deepEqual((await srv.call('GET', '/kb/index/search?q=a')).body.results, []);
  for (const qs of ['', '?q=', '?q=zebrafish&limit=0', '?q=zebrafish&limit=51', '?q=zebrafish&limit=x', `?q=${'x'.repeat(201)}`, `?q=zebrafish&projectId=${'p'.repeat(201)}`]) {
    const e = await srv.call('GET', `/kb/index/search${qs}`);
    assert.equal(e.status, 400, qs);
    assert.equal(e.body.error.code, 'VALIDATION_FAILED');
  }
});
