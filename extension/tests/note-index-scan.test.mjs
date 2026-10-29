// Chunked note-index scan (live-then-archive Phase 2, plan 3.8): a library too
// large for one reconcile is sent as chunks. Only a complete final chunk may
// prune; a missing chunk, an expired scan or a restart costs a 409 and prunes
// nothing. Covers a 20 000-note library. Temp DB only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_note-index-scan-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const ni = await import('../kb/note-index.mjs');
const { AppError } = await import('../core/errors.mjs');
const conn = db.getDb();
const pass = 'CorrectHorseBattery';
// Each test gets its own users, so rows never leak between tests.
let seq = 0;
const newUser = () => users.registerUser(conn, { email: `scan-${seq += 1}-${Date.now()}@example.test`, password: pass, displayName: 'u' }).id;
let U = null;
let V = null;

test.after(() => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });
});

const SCAN = 'scan-0001-aaaa';
const note = (key, hash = `h-${key}`) => ({ noteKey: key, title: key, date: '2026-01-05T10:00:00.000Z', body: 'x', contentHash: hash });
function seedRows(user, keys) {
  for (let i = 0; i < keys.length; i += 50) ni.upsertNotes(user, keys.slice(i, i + 50).map((k) => note(k)), { projectId: 'p' });
}
const rowKeys = (user) => conn.prepare('SELECT note_key FROM note_index WHERE user_id = ? AND project_id = ? ORDER BY note_key')
  .all(user, 'p').map((r) => r.note_key);
function chunksOf(keys, size) {
  const out = [];
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size));
  return out;
}
/** Sends every chunk of a manifest; `skip` drops one chunk index on purpose. */
function sendScan(user, manifestKeys, { prune = true, skip = -1, scanId = SCAN, now } = {}) {
  const parts = chunksOf(manifestKeys, 500);
  let last;
  parts.forEach((part, i) => {
    if (i === skip) return;
    const final = i === parts.length - 1;
    last = ni.scanNoteChunk(user, {
      projectId: 'p', scanId, index: i, total: parts.length, complete: final, prune: final && prune,
      entries: part.map((k) => ({ noteKey: k, contentHash: `h-${k}` })),
    }, { now });
  });
  return last;
}

test('a complete scan prunes exactly the rows no chunk named, and classifies missing and stale per chunk', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['a.md', 'b.md', 'c.md', 'gone.md']);
  // a and b are current, c changed (stale), d is new (missing), gone is not in the manifest.
  conn.prepare("UPDATE note_index SET content_hash = 'old' WHERE note_key = 'c.md'").run();
  const manifest = ['a.md', 'b.md', 'c.md', 'd.md'];
  const r = sendScan(U, manifest, { prune: true });
  assert.equal(r.complete, true);
  assert.equal(r.received, 1);
  assert.deepEqual(r.extra, ['gone.md']);
  assert.equal(r.pruned, 1);
  assert.deepEqual(rowKeys(U), ['a.md', 'b.md', 'c.md']);
  // the non-final classification happened on the chunk that carried each key
  const probe = ni.scanNoteChunk(U, { projectId: 'p', scanId: 'probe-0001', index: 0, total: 2, complete: false,
    entries: [{ noteKey: 'd.md', contentHash: 'h-d.md' }, { noteKey: 'zz.md', contentHash: 'h' }] });
  assert.deepEqual(probe.missing, ['d.md', 'zz.md']);
});

test('a missing chunk is a 409 and prunes nothing', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['keep-1.md', 'keep-2.md', 'stale-by-scan.md']);
  const before = rowKeys(U);
  const manifest = Array.from({ length: 1200 }, (_, i) => `m${String(i).padStart(4, '0')}.md`);
  assert.throws(() => sendScan(U, manifest, { prune: true, skip: 1, scanId: 'scan-dropped-01' }),
    (err) => err instanceof AppError && err.code === 'SCAN_INCOMPLETE' && err.status === 409);
  assert.deepEqual(rowKeys(U), before, 'nothing was pruned after a dropped chunk');
});

test('prune false reports the extra rows and deletes none', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['x-1.md', 'x-2.md']);
  const r = sendScan(U, ['x-1.md'], { prune: false, scanId: 'scan-report-01' });
  assert.deepEqual(r.extra, ['x-2.md']);
  assert.equal(r.pruned, 0);
  assert.ok(rowKeys(U).includes('x-2.md'));
});

test('an expired scan is forgotten: its final chunk cannot prune the other chunks it never saw', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['e-1.md', 'e-2.md', 'e-3.md']);
  const t0 = 1_000_000;
  // chunk 0 of 2 at t0; the final chunk arrives after the TTL, so the first chunk's keys are gone
  ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-ttl-0001', index: 0, total: 2, complete: false,
    entries: [{ noteKey: 'e-1.md', contentHash: 'h-e-1.md' }] }, { now: t0 });
  assert.throws(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-ttl-0001', index: 1, total: 2,
    complete: true, prune: true, entries: [{ noteKey: 'e-3.md', contentHash: 'h-e-3.md' }] },
    { now: t0 + ni.SCAN_TTL_MS + 1 }),
  (err) => err instanceof AppError && err.code === 'SCAN_INCOMPLETE');
  assert.deepEqual(rowKeys(U), ['e-1.md', 'e-2.md', 'e-3.md'], 'expiry prunes nothing');
});

test('a restart (no scan state) cannot prune on a final chunk alone when the scan had more chunks', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['r-1.md', 'r-2.md']);
  assert.throws(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-restart-1', index: 1, total: 3,
    complete: true, prune: true, entries: [{ noteKey: 'r-1.md', contentHash: 'h-r-1.md' }] }),
  (err) => err instanceof AppError && err.code === 'SCAN_INCOMPLETE');
  assert.deepEqual(rowKeys(U), ['r-1.md', 'r-2.md']);
});

test('a 20 000-note library is sent in 40 chunks and prunes only its own stale rows', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  const all = Array.from({ length: 20000 }, (_, i) => `lib/n${String(i).padStart(5, '0')}.md`);
  seedRows(U, all);
  // the library lost 2 notes on disk: they must be pruned, nothing else
  const manifest = all.slice(0, 19998);
  const r = sendScan(U, manifest, { prune: true, scanId: 'scan-big-00001' });
  assert.equal(r.total, 40);
  assert.equal(r.pruned, 2);
  assert.equal(rowKeys(U).length, 19998);
});

test('input bounds are refused before any state changes', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  const bad = (over) => ({ projectId: 'p', scanId: 'scan-bounds-01', index: 0, total: 1, complete: true,
    entries: [], ...over });
  const refuse = (over) => assert.throws(() => ni.scanNoteChunk(U, bad(over)),
    (err) => err.code === 'VALIDATION_FAILED' && err.status === 400);
  refuse({ scanId: 'short' });
  refuse({ index: 1, total: 1 });
  refuse({ total: 101 });
  refuse({ complete: false, prune: true });
  refuse({ entries: Array.from({ length: 501 }, (_, i) => ({ noteKey: `k${i}.md`, contentHash: 'h' })) });
  refuse({ entries: [{ noteKey: '../escape.md', contentHash: 'h' }] });
  ni.scanNoteChunk(U, bad({ total: 3, index: 0, complete: false, entries: [], scanId: 'scan-total-01' }));
  assert.throws(() => ni.scanNoteChunk(U, bad({ total: 2, index: 0, complete: false, entries: [], scanId: 'scan-total-01' })),
    (err) => err.code === 'VALIDATION_FAILED');
});

test('open scans are capped per user and never touch another user', () => {
  U = newUser();
  V = newUser();
  ni.resetNoteIndexScans();
  seedRows(V, ['v-only.md']);
  for (let i = 0; i < ni.MAX_OPEN_SCANS; i += 1) {
    ni.scanNoteChunk(U, { projectId: 'p', scanId: `open-scan-0${i}`, index: 0, total: 2, complete: false, entries: [] });
  }
  assert.throws(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'open-scan-09', index: 0, total: 2, complete: false, entries: [] }),
    (err) => err.code === 'SCAN_LIMIT' && err.status === 429);
  // another user's complete scan does not prune user U's rows
  ni.scanNoteChunk(V, { projectId: 'p', scanId: 'v-scan-000001', index: 0, total: 1, complete: true, prune: true, entries: [] });
  assert.deepEqual(conn.prepare('SELECT note_key FROM note_index WHERE user_id = ? AND project_id = ?').all(V, 'p').map((r) => r.note_key), []);
});
