// Migration 0050 (live-then-archive, Phase 1 T1.1): schema golden, trigger
// parity for note_index -> search (FTS), rowid mapping (F12), cascade cleanup,
// and idempotent re-run. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_note-index-migration-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const conn = db.getDb();

const U = users.registerUser(conn, {
  email: `ni-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'ni',
}).id;
const V = users.registerUser(conn, {
  email: `ni2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'ni2',
}).id;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const cols = (table) => conn.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const insNote = (over = {}) => conn.prepare(`
  INSERT INTO note_index (user_id, project_id, note_key, title, date, body_text, content_hash, mtime_ms)
  VALUES (@user_id, @project_id, @note_key, @title, @date, @body_text, @content_hash, @mtime_ms)
`).run({
  user_id: U, project_id: 'p1', note_key: 'meetings/2026/01/a.md', title: 'Budget review',
  date: '2026-01-05T10:00:00.000Z', body_text: 'the rollback plan', content_hash: 'h1', mtime_ms: 1,
  ...over,
});
const ftsFor = (id) => conn.prepare(
  "SELECT rowid, kind, title, body FROM search WHERE meeting_id = ?").all(`\u0001note:${id}`);

test('schema golden: note_index, the map, tombstones and ack ledger have the planned columns', () => {
  assert.deepEqual(cols('note_index'), [
    'id', 'user_id', 'project_id', 'note_key', 'kind', 'title', 'date', 'duration_sec',
    'participants', 'body_text', 'content_hash', 'mtime_ms', 'meta', 'indexed_at',
  ]);
  assert.deepEqual(cols('note_index_search'), ['note_id', 'search_rowid']);
  assert.deepEqual(cols('pending_session_purges'), [
    'deleted_chat_id', 'owner_user_id', 'reason', 'attempts', 'requested_at',
    'sdk_session_ids', 'state', 'next_attempt_at',
  ]);
  assert.deepEqual(cols('live_acks'), [
    'session_id', 'owner_user_id', 'note_key_hash', 'content_hash', 'lines', 'outcome', 'acked_at',
  ]);
  assert.deepEqual(cols('live_crash_rows'), [
    'session_id', 'owner_user_id', 'title', 'started_at', 'duration_sec', 'transcript',
    'lines', 'content_hash', 'bytes', 'finalized_at', 'expires_at',
  ]);
});

test('schema golden: chat_sessions gained the additive lifecycle columns with safe defaults', () => {
  const c = cols('chat_sessions');
  for (const k of ['meeting_id', 'owner_user_id', 'origin', 'lifecycle', 'fence', 'archive_since']) {
    assert.ok(c.includes(k), `missing ${k}`);
  }
  const row = conn.prepare(`
    INSERT INTO chat_sessions (id, user_id, title, surface, mode, created_at, updated_at)
    VALUES ('lta-default', ?, 't', 'extension', 'transcript', 1, 1)`).run(U);
  assert.equal(row.changes, 1);
  const s = conn.prepare("SELECT origin, lifecycle, fence, meeting_id, archive_since FROM chat_sessions WHERE id = 'lta-default'").get();
  assert.deepEqual(s, { origin: 'extension', lifecycle: 'live', fence: 0, meeting_id: null, archive_since: null });
});

test('the migration is recorded once; a re-run of the runner is a no-op', async () => {
  const mig = await import('../kb/migrations.mjs');
  const before = conn.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 50").get().n;
  assert.equal(before, 1);
  const applied = mig.applyMigrations(conn);
  assert.equal(applied?.applied ?? 0, 0, 'a second run applies nothing');
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 50").get().n, 1);
});

test('insert indexes exactly one FTS row, findable by its body', () => {
  const id = Number(insNote().lastInsertRowid);
  const rows = ftsFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'note');
  assert.equal(rows[0].title, 'Budget review');
  assert.equal(rows[0].body, 'the rollback plan');
  const map = conn.prepare('SELECT search_rowid FROM note_index_search WHERE note_id = ?').get(id);
  assert.equal(map.search_rowid, rows[0].rowid, 'the map names the FTS row the insert wrote');
});

test('update replaces the FTS row in place: one row, new body, map follows', () => {
  const id = Number(insNote({ note_key: 'meetings/2026/01/b.md', content_hash: 'hb' }).lastInsertRowid);
  conn.prepare('UPDATE note_index SET body_text = ?, content_hash = ? WHERE id = ?').run('alpha beta', 'hb2', id);
  const rows = ftsFor(id);
  assert.deepEqual(rows.map((r) => r.body), ['alpha beta'], 'no duplicate, no stale body');
  const map = conn.prepare('SELECT search_rowid FROM note_index_search WHERE note_id = ?').get(id);
  assert.equal(map.search_rowid, rows[0].rowid);
  const hit = conn.prepare("SELECT meeting_id FROM search WHERE search MATCH 'alpha' AND meeting_id = ?").all(`\u0001note:${id}`);
  assert.equal(hit.length, 1, 'the new body is searchable');
  const old = conn.prepare("SELECT meeting_id FROM search WHERE search MATCH 'rollback' AND meeting_id = ?").all(`\u0001note:${id}`);
  assert.equal(old.length, 0, 'the old body is gone from the index');
});

test('delete removes the FTS row and the map row', () => {
  const id = Number(insNote({ note_key: 'meetings/2026/01/c.md' }).lastInsertRowid);
  assert.equal(ftsFor(id).length, 1);
  conn.prepare('DELETE FROM note_index WHERE id = ?').run(id);
  assert.deepEqual(ftsFor(id), []);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM note_index_search WHERE note_id = ?').get(id).n, 0);
});

test('parity: after many writes the FTS row count equals the note count', () => {
  for (let i = 0; i < 25; i++) insNote({ note_key: `meetings/parity/${i}.md`, content_hash: `p${i}` });
  conn.prepare("UPDATE note_index SET body_text = 'changed' WHERE note_key LIKE 'meetings/parity/%' AND id % 2 = 0").run();
  conn.prepare("DELETE FROM note_index WHERE note_key LIKE 'meetings/parity/%' AND id % 5 = 0").run();
  const notes = conn.prepare("SELECT COUNT(*) AS n FROM note_index").get().n;
  const fts = conn.prepare("SELECT COUNT(*) AS n FROM search WHERE meeting_id LIKE '\u0001note:%'").get().n;
  const mapped = conn.prepare('SELECT COUNT(*) AS n FROM note_index_search').get().n;
  assert.equal(fts, notes);
  assert.equal(mapped, notes);
});

test('user-delete cascade removes the user notes and their FTS rows, not another user\'s', () => {
  const mine = Number(insNote({ user_id: V, note_key: 'v/1.md', content_hash: 'v1', body_text: 'vendor secret plan' }).lastInsertRowid);
  const doomed = Number(insNote({ user_id: U, note_key: 'u/1.md', content_hash: 'u1', body_text: 'doomed text' }).lastInsertRowid);
  conn.prepare("INSERT INTO pending_session_purges (deleted_chat_id, owner_user_id) VALUES ('c-x', ?)").run(U);
  conn.prepare("INSERT INTO live_acks (session_id, owner_user_id, note_key_hash, content_hash, acked_at) VALUES ('s-x', ?, 'k', 'h', '2026-01-01T00:00:00.000Z')").run(U);
  conn.prepare("INSERT INTO live_crash_rows (session_id, owner_user_id, title, started_at, transcript, lines, content_hash, bytes, finalized_at, expires_at) VALUES ('c-x', ?, 't', 's', 'secret transcript', 1, 'h', 1, 'f', 'e')").run(U);
  const counts = db.deleteUserCascade(U);
  assert.ok(counts.note_index >= 1);
  assert.equal(counts.pending_session_purges, 1);
  assert.equal(counts.live_acks, 1);
  assert.equal(counts.live_crash_rows, 1);
  assert.deepEqual(ftsFor(doomed), []);
  assert.equal(ftsFor(mine).length, 1, 'the other user\'s note and its FTS row survive');
});

test('note FTS rows are kind note and never reached by an unfiltered search', async () => {
  const kinds = conn.prepare("SELECT kind FROM search WHERE meeting_id = ?").all(`\u0001note:${Number(insNote({ note_key: 'k/kind.md', body_text: 'zebrafish memo' }).lastInsertRowid)}`).map((r) => r.kind);
  assert.deepEqual(kinds, ['note']);
  const { search } = await import('../kb/db.mjs');
  assert.deepEqual(search(U, { q: 'zebrafish' }).map((h) => h.title), [], 'an unfiltered search does not return note rows');
  assert.deepEqual(search(U, { q: 'zebrafish', kind: 'meeting' }), [], 'nor a meeting-kind search');
});

test('a client meeting id cannot name a note row: the reserved prefix and control characters are refused', async () => {
  const { ingestMeeting } = await import('../kb/meetings.mjs');
  assert.throws(() => ingestMeeting(U, { id: '\u0001note:1', title: 'x', transcript: 'y' }), /reserved prefix|control/);
  assert.throws(() => ingestMeeting(U, { id: 'bad\nid', title: 'x', transcript: 'y' }), /control/);
  assert.throws(() => ingestMeeting(U, { id: 'n'.repeat(201), title: 'x', transcript: 'y' }), /longer/);
});

test('colliding ids: user B\'s meeting "n:N" and its delete cannot remove user A\'s note FTS row', async () => {
  const { ingestMeeting, deleteMeeting } = await import('../kb/meetings.mjs');
  const mine = Number(insNote({ user_id: U, note_key: 'collide/a.md', body_text: 'alphaunique note' }).lastInsertRowid);
  // The id that used to produce the same FTS meeting_id as the note's old 'n:' prefix.
  ingestMeeting(V, { id: `n:${mine}`, title: 'B', transcript: 'bravo' });
  deleteMeeting(V, `n:${mine}`);
  assert.equal(ftsFor(mine).length, 1, 'A\'s note FTS row survives B\'s meeting delete');
});
