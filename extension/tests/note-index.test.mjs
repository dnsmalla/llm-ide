// kb/note-index.mjs (live-then-archive T1.2): idempotent upsert, reconcile
// classes, project scoping, redaction at build, the body cap, per-user
// isolation, and hidden notes never indexed. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_note-index-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const ni = await import('../kb/note-index.mjs');
const conn = db.getDb();

const pass = 'CorrectHorseBattery';
const U = users.registerUser(conn, { email: `nix-${Date.now()}@example.test`, password: pass, displayName: 'u' }).id;
const V = users.registerUser(conn, { email: `niy-${Date.now()}@example.test`, password: pass, displayName: 'v' }).id;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const note = (key, over = {}) => ({
  noteKey: key, title: `Title ${key}`, date: '2026-01-05T10:00:00.000Z',
  durationSec: 60, participants: ['Ana'], body: `body of ${key}`,
  contentHash: `hash-${key}`, mtimeMs: 1, ...over,
});

test('upsert is idempotent: the second send of the same batch writes nothing', () => {
  const batch = [note('meetings/a.md'), note('meetings/b.md')];
  assert.deepEqual(ni.upsertNotes(U, batch), { upserted: 2, unchanged: 0, skippedHidden: 0, truncated: 0, removed: 0 });
  assert.deepEqual(ni.upsertNotes(U, batch), { upserted: 0, unchanged: 2, skippedHidden: 0, truncated: 0, removed: 0 });
  assert.equal(ni.indexStatus(U).notes, 2);
  assert.equal(ni.indexStatus(U).consistent, true);
});

test('a changed note is updated in place and re-indexed', () => {
  ni.upsertNotes(U, [note('meetings/a.md', { body: 'first version', contentHash: 'v1' })]);
  const r = ni.upsertNotes(U, [note('meetings/a.md', { body: 'second version', contentHash: 'v2' })]);
  assert.equal(r.upserted, 1);
  const row = conn.prepare("SELECT body_text, content_hash FROM note_index WHERE user_id = ? AND note_key = 'meetings/a.md'").get(U);
  assert.deepEqual({ ...row }, { body_text: 'second version', content_hash: 'v2' });
  assert.equal(ni.indexStatus(U).consistent, true);
});

test('reconcile reports missing, stale and extra; prune deletes only the extras', () => {
  ni.upsertNotes(U, [note('rec/keep.md'), note('rec/stale.md'), note('rec/extra.md')]);
  const manifest = [
    { noteKey: 'rec/keep.md', contentHash: 'hash-rec/keep.md' },
    { noteKey: 'rec/stale.md', contentHash: 'NEW' },
    { noteKey: 'rec/missing.md', contentHash: 'm' },
  ];
  const dry = ni.reconcileNotes(U, { manifest });
  assert.deepEqual(dry.missing, ['rec/missing.md']);
  assert.deepEqual(dry.stale, ['rec/stale.md']);
  assert.ok(dry.extra.includes('rec/extra.md'));
  assert.equal(dry.pruned, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'rec/extra.md'").get(U).n, 1, 'dry run keeps the extra');

  const pruned = ni.reconcileNotes(U, { manifest, prune: true });
  assert.equal(pruned.pruned, pruned.extra.length);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'rec/extra.md'").get(U).n, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'rec/keep.md'").get(U).n, 1, 'a matching note is kept');
  assert.equal(ni.indexStatus(U).consistent, true, 'the FTS rows went with the pruned notes');
});

test('project scoping: the same key in two projects is two rows, and reconcile sees one project only', () => {
  ni.upsertNotes(U, [note('shared/x.md', { body: 'in alpha' })], { projectId: 'alpha' });
  ni.upsertNotes(U, [note('shared/x.md', { body: 'in beta' })], { projectId: 'beta' });
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'shared/x.md'").get(U).n, 2);
  const r = ni.reconcileNotes(U, { projectId: 'alpha', manifest: [], prune: true });
  assert.ok(r.extra.includes('shared/x.md'));
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND project_id = 'beta' AND note_key = 'shared/x.md'").get(U).n, 1, 'the other project is untouched');
  assert.equal(ni.indexStatus(U, { projectId: 'beta' }).notes, 1);
});

test('redaction at build: a pasted key is removed from body_text and title, the file stays the caller\'s', () => {
  const key = 'sk-ant-api03-' + 'A'.repeat(40);
  ni.upsertNotes(U, [note('secret/s.md', { body: `please use ${key} for the demo`, title: `key ${key}` })]);
  const row = conn.prepare("SELECT body_text, title FROM note_index WHERE user_id = ? AND note_key = 'secret/s.md'").get(U);
  assert.ok(!row.body_text.includes(key), 'body is redacted');
  assert.ok(!row.title.includes(key), 'title is redacted');
  assert.ok(row.body_text.includes('for the demo'), 'surrounding text survives');
  const fts = conn.prepare("SELECT body, title FROM search WHERE meeting_id = ?").all('\u0001note:' + conn.prepare("SELECT id FROM note_index WHERE user_id = ? AND note_key = 'secret/s.md'").get(U).id);
  assert.equal(fts.length, 1);
  assert.ok(!fts[0].body.includes(key) && !fts[0].title.includes(key), 'the FTS row text is redacted too');
});

test('the body is capped at 200 KiB on a UTF-8 boundary and reported as truncated', () => {
  const big = '会議'.repeat(100 * 1024); // 3 bytes per char, ~600 KiB
  const r = ni.upsertNotes(U, [note('big/long.md', { body: big })]);
  assert.equal(r.truncated, 1);
  const stored = conn.prepare("SELECT body_text FROM note_index WHERE user_id = ? AND note_key = 'big/long.md'").get(U).body_text;
  assert.ok(Buffer.byteLength(stored, 'utf8') <= ni.BODY_CAP_BYTES);
  assert.ok(Buffer.byteLength(stored, 'utf8') > ni.BODY_CAP_BYTES - 4, 'the cap is used, not wasted');
  assert.ok(!stored.includes('�'), 'no split character');
});

test('hidden notes are never indexed and are counted', () => {
  const r = ni.upsertNotes(U, [note('hidden/h.md', { hidden: true })]);
  assert.deepEqual(r, { upserted: 0, unchanged: 0, skippedHidden: 1, truncated: 0, removed: 0 });
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'hidden/h.md'").get(U).n, 0);
});

test('per-user isolation: another user cannot read, reconcile or delete these notes', () => {
  ni.upsertNotes(U, [note('iso/u.md')]);
  assert.equal(ni.indexStatus(V).notes, 0, 'V has no notes of its own');
  assert.equal(ni.deleteNote(V, { noteKey: 'iso/u.md' }), false, 'V cannot delete U\'s note');
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'iso/u.md'").get(U).n, 1);
  const r = ni.reconcileNotes(V, { manifest: [], prune: true });
  assert.ok(!r.extra.includes('iso/u.md'), 'V\'s reconcile does not see U\'s notes');
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'iso/u.md'").get(U).n, 1);
});

test('validation: bad keys, oversized batches and bad shapes are refused', () => {
  assert.throws(() => ni.upsertNotes(U, [note('../escape.md')]), /noteKey/);
  assert.throws(() => ni.upsertNotes(U, [note('/abs.md')]), /noteKey/);
  assert.throws(() => ni.upsertNotes(U, Array.from({ length: 101 }, (_, i) => note(`b/${i}.md`))), /per batch/);
  assert.throws(() => ni.upsertNotes(U, [note('ok.md', { kind: 'chat' })]), /kind/);
  assert.throws(() => ni.upsertNotes(U, [note('ok.md', { durationSec: -1 })]), /durationSec/);
  assert.throws(() => ni.reconcileNotes(U, { manifest: 'nope' }), /manifest/);
  assert.throws(() => ni.upsertNotes(null, []), /userId/);
});

test('a note indexed while visible and later hidden is REMOVED: row, FTS row and map', () => {
  ni.upsertNotes(U, [note('vis/then-hidden.md', { body: 'soon hidden text' })]);
  const id = conn.prepare("SELECT id FROM note_index WHERE user_id = ? AND note_key = 'vis/then-hidden.md'").get(U).id;
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM search WHERE meeting_id = ?").get('\u0001note:' + id).n, 1);
  const r = ni.upsertNotes(U, [note('vis/then-hidden.md', { hidden: true })]);
  assert.deepEqual(r, { upserted: 0, unchanged: 0, skippedHidden: 1, truncated: 0, removed: 1 });
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE id = ?").get(id).n, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM search WHERE meeting_id = ?").get('\u0001note:' + id).n, 0, 'FTS row gone');
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index_search WHERE note_id = ?").get(id).n, 0, 'map row gone');
  assert.equal(ni.indexStatus(U).consistent, true);
});

test('moving a note to another project: reconcile removes the old project FTS row, the new project gets its own', () => {
  ni.upsertNotes(U, [note('move/x.md', { body: 'movable words' })], { projectId: 'old-proj' });
  const oldId = conn.prepare("SELECT id FROM note_index WHERE user_id = ? AND project_id = 'old-proj' AND note_key = 'move/x.md'").get(U).id;
  ni.reconcileNotes(U, { projectId: 'old-proj', manifest: [], prune: true });
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM search WHERE meeting_id = ?").get('\u0001note:' + oldId).n, 0, 'old project FTS row removed');
  ni.upsertNotes(U, [note('move/x.md', { body: 'movable words' })], { projectId: 'new-proj' });
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM note_index WHERE user_id = ? AND note_key = 'move/x.md'").get(U).n, 1);
  assert.equal(ni.indexStatus(U, { projectId: 'new-proj' }).consistent, true);
});

test('a search-table rebuild that renumbers rows is detected, and rebuildNoteIndexSearch restores it without touching other rows', () => {
  ni.upsertNotes(U, [note('rb/a.md', { body: 'rebuild target' })]);
  const id = conn.prepare("SELECT id FROM note_index WHERE user_id = ? AND note_key = 'rb/a.md'").get(U).id;
  // An unrelated FTS row, and a map entry that now points at it (a renumbered table).
  const other = Number(conn.prepare("INSERT INTO search (meeting_id, entity_id, kind, title, body) VALUES ('m-other', NULL, 'meeting', 'other', 'unrelated')").run().lastInsertRowid);
  conn.prepare('UPDATE note_index_search SET search_rowid = ? WHERE note_id = ?').run(other, id);
  assert.equal(ni.indexStatus(U).consistent, false, 'the stale map is reported');
  const rebuilt = ni.rebuildNoteIndexSearch(conn);
  assert.ok(rebuilt >= 1);
  assert.equal(ni.indexStatus(U).consistent, true, 'the map is restored');
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM search WHERE rowid = ? AND meeting_id = 'm-other'").get(other).n, 1, 'the unrelated row is untouched');
});
