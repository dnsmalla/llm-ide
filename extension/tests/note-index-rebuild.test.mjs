// Rebuild proof (live-then-archive Phase 2, T2.3): the note index holds no unique
// data. Feed the Swift-written payload (tests/fixtures/lta/note-index-feed.json,
// produced by the reconciler's own upsert builder), record counts and search
// results, drop every note row and every note FTS row, feed the same payload
// again, and assert the counts and results are equal. A second drill drops only
// the FTS rows and rebuilds them from note_index. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_note-index-rebuild-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const ni = await import('../kb/note-index.mjs');
const conn = db.getDb();

const feed = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/lta/note-index-feed.json'), 'utf8'));
const U = users.registerUser(conn, { email: `rebuild-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 'u' }).id;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

/** Feed the payload the way the Mac does: batches of at most 50 notes. */
function feedAll() {
  const totals = { upserted: 0, unchanged: 0, skippedHidden: 0, truncated: 0, removed: 0 };
  for (let i = 0; i < feed.notes.length; i += 50) {
    const r = ni.upsertNotes(U, feed.notes.slice(i, i + 50), { projectId: feed.projectId });
    for (const k of Object.keys(totals)) totals[k] += r[k];
  }
  return totals;
}

const count = (sql, ...args) => conn.prepare(sql).get(...args).n;
const counts = () => ({
  notes: count('SELECT COUNT(*) AS n FROM note_index WHERE user_id = ?', U),
  noteFts: count("SELECT COUNT(*) AS n FROM search WHERE kind = 'note'"),
  noteMap: count('SELECT COUNT(*) AS n FROM note_index_search'),
});

/** Ranked results for a fixed query set, as sorted (meetingId, title, rank) tuples. */
function snapshot() {
  const titles = feed.notes.map((n) => n.title);
  const words = [...new Set(titles.flatMap((t) => t.split(/[^\p{L}\p{N}_]+/u)).filter((w) => [...w].length >= 3))];
  const queries = [...titles, ...words, '予算', '設計', '見積', 'rollback', 'standup', 'budget'];
  const out = {};
  for (const q of queries) {
    out[q] = ni.searchNoteIndex(U, { q, limit: 10 })
      .map((h) => `${h.meetingId}|${h.title}|${h.date}|${h.rank}`)
      .sort();
  }
  out['(list newest)'] = ni.searchNoteIndex(U, { q: '', limit: 10 })
    .map((h) => `${h.meetingId}|${h.title}|${h.date}`).sort();
  return out;
}

test('the feed loads and the index agrees with its search rows before the drop', () => {
  const totals = feedAll();
  assert.equal(totals.upserted, feed.notes.length);
  assert.equal(totals.skippedHidden, 0);
  const c = counts();
  assert.equal(c.notes, feed.notes.length);
  assert.equal(c.noteFts, feed.notes.length);
  assert.equal(c.noteMap, feed.notes.length);
  assert.equal(ni.indexStatus(U).consistent, true);
});

test('the server redacts the body it indexes (the Mac file stays raw)', () => {
  const bodies = conn.prepare('SELECT body_text FROM note_index WHERE user_id = ?').all(U).map((r) => r.body_text);
  assert.ok(bodies.every((b) => !b.includes('EXAMPLEKEY1234567890')), 'a secret must not reach the index');
});

test('drop every note row and note FTS row, re-feed: counts and search results are equal', () => {
  const before = counts();
  const beforeResults = snapshot();
  assert.ok(before.notes > 0);

  // The drop: all note rows (their FTS rows go with the delete triggers), then the
  // leftovers explicitly, so the proof does not depend on the triggers alone.
  conn.prepare('DELETE FROM note_index').run();
  conn.prepare("DELETE FROM search WHERE kind = 'note'").run();
  conn.prepare('DELETE FROM note_index_search').run();
  assert.deepEqual(counts(), { notes: 0, noteFts: 0, noteMap: 0 });
  assert.deepEqual(ni.searchNoteIndex(U, { q: 'budget', limit: 10 }), []);

  feedAll();
  assert.deepEqual(counts(), before);
  assert.deepEqual(snapshot(), beforeResults);
  assert.equal(ni.indexStatus(U).consistent, true);
});

test('drop only the FTS rows, rebuild them from note_index: results are equal', () => {
  const beforeResults = snapshot();
  conn.prepare("DELETE FROM search WHERE kind = 'note'").run();
  conn.prepare('DELETE FROM note_index_search').run();
  assert.equal(ni.indexStatus(U).consistent, false, 'a dropped FTS side must show as inconsistent');
  ni.rebuildNoteIndexSearch(conn);
  assert.equal(ni.indexStatus(U).consistent, true);
  assert.deepEqual(snapshot(), beforeResults);
});
