// A `sources` row's FTS row is now found BY ROWID (migration 0037's
// search_source_rowid map). Before, the update/delete triggers matched
// `kind = ? AND entity_id = ?` — UNINDEXED FTS5 columns, i.e. a scan of the
// whole virtual table per row, paid once per chunk on every project-open
// re-ingest, inside one write transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-search-source-rowid-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

const U = users.registerUser(db.getDb(), {
  email: `sr-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 's',
}).id;
const conn = db.getDb();

const addSource = (ref, body) => Number(conn.prepare(
  "INSERT INTO sources (kind, ref, chunk_idx, title, body, user_id) VALUES ('code', ?, 0, ?, ?, ?)",
).run(ref, ref, body, U).lastInsertRowid);
const ftsRows = (id) => conn.prepare(
  "SELECT rowid, body FROM search WHERE kind = 'code' AND entity_id = ?").all(String(id));
const mapped = (id) => conn.prepare(
  'SELECT search_rowid FROM search_source_rowid WHERE source_id = ?').get(id)?.search_rowid;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

test('a source records its FTS rowid, and updates and deletes follow it', () => {
  const id = addSource('/r/a.ts', 'alpha body');
  const [row] = ftsRows(id);
  assert.equal(mapped(id), row.rowid, 'the map names the row the insert trigger wrote');
  conn.prepare('UPDATE sources SET body = ? WHERE id = ?').run('beta body', id);
  const after = ftsRows(id);
  assert.deepEqual(after.map((r) => r.body), ['beta body'], 'an update replaces the row, never duplicates it');
  assert.equal(mapped(id), after[0].rowid);
  conn.prepare('DELETE FROM sources WHERE id = ?').run(id);
  assert.deepEqual(ftsRows(id), []);
  assert.equal(mapped(id), undefined, 'the map row goes with it');
});

test('the INSERT still reports the SOURCE id as lastInsertRowid', () => {
  const before = conn.prepare('SELECT MAX(id) AS m FROM sources').get().m;
  const id = addSource('/r/id.ts', 'x');
  assert.ok(id > before, 'the trigger\'s own inserts do not leak into the caller\'s lastInsertRowid');
  assert.equal(conn.prepare('SELECT ref FROM sources WHERE id = ?').get(id).ref, '/r/id.ts');
});

test('a source written before the migration (no map row) is still updated and deleted correctly', () => {
  const id = addSource('/r/legacy.ts', 'legacy body');
  conn.prepare('DELETE FROM search_source_rowid WHERE source_id = ?').run(id);
  conn.prepare('UPDATE sources SET body = ? WHERE id = ?').run('legacy v2', id);
  assert.deepEqual(ftsRows(id).map((r) => r.body), ['legacy v2'], 'the old row was found the slow way, once');
  assert.ok(mapped(id), 'and the replacement is mapped from now on');

  const gone = addSource('/r/legacy-del.ts', 'doomed');
  conn.prepare('DELETE FROM search_source_rowid WHERE source_id = ?').run(gone);
  conn.prepare('DELETE FROM sources WHERE id = ?').run(gone);
  assert.deepEqual(ftsRows(gone), []);
});

test('the source triggers locate the old row by rowid', () => {
  const triggerSql = (name) => conn.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name).sql;
  for (const name of ['trg_sources_au', 'trg_sources_ad']) {
    const sql = triggerSql(name);
    assert.match(sql, /WHERE rowid = \(SELECT search_rowid FROM search_source_rowid WHERE source_id = OLD\.id\)/, name);
    assert.doesNotMatch(sql, /entity_id = CAST\(OLD\.id/, `${name} never scans by entity_id`);
  }
  // The slow path lives ONLY behind a trigger WHEN clause: measured, the same
  // NOT EXISTS as a WHERE term inside a trigger body still scans every row.
  for (const name of ['trg_sources_bu_legacy', 'trg_sources_bd_legacy']) {
    assert.match(triggerSql(name),
      /BEFORE (UPDATE|DELETE) ON sources\s+WHEN NOT EXISTS \(SELECT 1 FROM search_source_rowid WHERE source_id = OLD\.id\) BEGIN/,
      name);
  }
});

test('a LIKE-only search still interleaves kinds newest first: a new meeting outranks older code', () => {
  addSource('/r/old.ts', 'ui old');
  conn.prepare("INSERT INTO meetings (id, title, date, transcript, user_id) VALUES ('m-ui', 'ui sync', '2026-10-02', 'ui notes', ?)").run(U);
  const hits = db.search(U, { q: 'ui', limit: 5 });
  assert.equal(hits[0].kind, 'meeting', `newest first across kinds (got ${hits.map((h) => h.kind).join(',')})`);
});

test('a user purge removes their FTS rows and map rows, mapped and legacy alike', () => {
  const V = users.registerUser(conn, {
    email: `sr2-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'v',
  }).id;
  const add = (ref) => Number(conn.prepare(
    "INSERT INTO sources (kind, ref, chunk_idx, title, body, user_id) VALUES ('code', ?, 0, ?, 'purge me', ?)",
  ).run(ref, ref, V).lastInsertRowid);
  const mappedId = add('/v/mapped.ts');
  const legacyId = add('/v/legacy.ts');
  conn.prepare('DELETE FROM search_source_rowid WHERE source_id = ?').run(legacyId);
  db.deleteUserCascade(V);
  assert.deepEqual([...ftsRows(mappedId), ...ftsRows(legacyId)], []);
  assert.equal(mapped(mappedId), undefined);
});
