// Chunked note-index scan (live-then-archive Phase 2, plan 3.8, hardened after the review):
// only a complete final chunk may prune; a missing chunk, a count mismatch, an expired scan, a
// restart or an all-empty scan costs a refusal and prunes nothing. `keep` keys are never pruned.
// A new scan for a project abandons the unfinished ones. Covers a 20 000-note library. Temp DB only.
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
/** Sends every chunk of a manifest; `skip` drops one chunk on purpose; `keep` and `allowEmpty` go on the final chunk. */
async function sendScan(user, manifestKeys, { prune = true, skip = -1, scanId = SCAN, now, keep, allowEmpty, totalEntries } = {}) {
  const parts = manifestKeys.length ? chunksOf(manifestKeys, 500) : [[]];   // an empty library is one empty final chunk
  let last;
  for (let i = 0; i < parts.length; i += 1) {
    if (i === skip) continue;
    const final = i === parts.length - 1;
    const extra = final ? { totalEntries: totalEntries ?? manifestKeys.length, keep, allowEmpty } : {};
    last = await ni.scanNoteChunk(user, {
      projectId: 'p', scanId, index: i, total: parts.length, complete: final, prune: final && prune,
      entries: parts[i].map((k) => ({ noteKey: k, contentHash: `h-${k}` })), ...extra,
    }, { now });
  }
  return last;
}
const refusal = (code, status = 409) => (err) => err instanceof AppError && err.code === code && err.status === status;

test('a complete scan prunes exactly the rows no chunk named, and classifies missing and stale per chunk', async () => {
  U = newUser(); V = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['a.md', 'b.md', 'c.md', 'gone.md']);
  conn.prepare("UPDATE note_index SET content_hash = 'old' WHERE note_key = 'c.md'").run();
  const r = await sendScan(U, ['a.md', 'b.md', 'c.md', 'd.md']);
  assert.equal(r.complete, true);
  assert.deepEqual(r.extra, ['gone.md']);
  assert.equal(r.pruned, 1);
  assert.deepEqual(rowKeys(U), ['a.md', 'b.md', 'c.md']);
  const probe = await ni.scanNoteChunk(U, { projectId: 'p', scanId: 'probe-0001', index: 0, total: 2, complete: false,
    entries: [{ noteKey: 'd.md', contentHash: 'h-d.md' }, { noteKey: 'zz.md', contentHash: 'h' }] });
  assert.deepEqual(probe.missing, ['d.md', 'zz.md']);
});

test('a missing chunk is a 409 and prunes nothing', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['keep-1.md', 'keep-2.md', 'stale-by-scan.md']);
  const before = rowKeys(U);
  const manifest = Array.from({ length: 1200 }, (_, i) => `m${String(i).padStart(4, '0')}.md`);
  await assert.rejects(() => sendScan(U, manifest, { prune: true, skip: 1, scanId: 'scan-dropped-01' }), refusal('SCAN_INCOMPLETE'));
  assert.deepEqual(rowKeys(U), before);
});

test('a final chunk whose declared total does not match the received entries is refused, nothing pruned', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['t-1.md', 't-2.md']);
  await assert.rejects(() => sendScan(U, ['t-1.md'], { prune: true, scanId: 'scan-total-mis', totalEntries: 2 }), refusal('SCAN_TOTAL_MISMATCH'));
  assert.deepEqual(rowKeys(U), ['t-1.md', 't-2.md']);
});

test('the final chunk must declare totalEntries, and totalEntries belongs to the final chunk only', async () => {
  U = newUser();
  await assert.rejects(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-decl-0001', index: 0, total: 1, complete: true, entries: [] }),
    (err) => err.code === 'VALIDATION_FAILED');
  await assert.rejects(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-decl-0002', index: 0, total: 2, complete: false, totalEntries: 0, entries: [] }),
    (err) => err.code === 'VALIDATION_FAILED');
});

test('an all-empty scan with prune is refused unless allowEmpty is sent; with allowEmpty it prunes', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['e-1.md', 'e-2.md']);
  await assert.rejects(() => sendScan(U, [], { prune: true, scanId: 'scan-empty-0001' }), refusal('EMPTY_SCAN_REFUSED'));
  assert.deepEqual(rowKeys(U), ['e-1.md', 'e-2.md']);
  const r = await sendScan(U, [], { prune: true, scanId: 'scan-empty-0002', allowEmpty: true });
  assert.equal(r.pruned, 2);
  assert.deepEqual(rowKeys(U), []);
});

test('keep: a key named in keep is never pruned, while other removed keys still are', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['k-1.md', 'k-2.md', 'k-3.md']);
  const r = await sendScan(U, ['k-1.md'], { prune: true, scanId: 'scan-keep-0001', keep: ['k-2.md'] });
  assert.deepEqual(r.extra, ['k-3.md']);
  assert.equal(r.pruned, 1);
  assert.deepEqual(rowKeys(U), ['k-1.md', 'k-2.md']);
});

test('prune false reports the extra rows and deletes none', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['x-1.md', 'x-2.md']);
  const r = await sendScan(U, ['x-1.md'], { prune: false, scanId: 'scan-report-01' });
  assert.deepEqual(r.extra, ['x-2.md']);
  assert.equal(r.pruned, 0);
  assert.ok(rowKeys(U).includes('x-2.md'));
});

test('an expired scan is forgotten: its final chunk cannot prune the chunks it never saw', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['e-1.md', 'e-2.md', 'e-3.md']);
  const t0 = 1_000_000;
  await ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-ttl-0001', index: 0, total: 2, complete: false,
    entries: [{ noteKey: 'e-1.md', contentHash: 'h-e-1.md' }] }, { now: t0 });
  await assert.rejects(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-ttl-0001', index: 1, total: 2,
    complete: true, prune: true, totalEntries: 1, entries: [{ noteKey: 'e-3.md', contentHash: 'h-e-3.md' }] },
  { now: t0 + ni.SCAN_TTL_MS + 1 }), refusal('SCAN_INCOMPLETE'));
  assert.deepEqual(rowKeys(U), ['e-1.md', 'e-2.md', 'e-3.md']);
});

test('a restart (no scan state) cannot prune on a final chunk alone when the scan had more chunks', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  seedRows(U, ['r-1.md', 'r-2.md']);
  await assert.rejects(() => ni.scanNoteChunk(U, { projectId: 'p', scanId: 'scan-restart-1', index: 1, total: 3,
    complete: true, prune: true, totalEntries: 1, entries: [{ noteKey: 'r-1.md', contentHash: 'h-r-1.md' }] }),
  refusal('SCAN_INCOMPLETE'));
  assert.deepEqual(rowKeys(U), ['r-1.md', 'r-2.md']);
});

test('a new scan for the project abandons the unfinished one: a retry never reaches SCAN_LIMIT', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  for (let i = 0; i < ni.MAX_OPEN_SCANS + 3; i += 1) {
    await ni.scanNoteChunk(U, { projectId: 'p', scanId: `abandon-0${i}-xxxx`, index: 0, total: 2, complete: false, entries: [] });
  }
  // only one open scan survives for the project
  const r = await sendScan(U, ['a-1.md'], { prune: false, scanId: 'retry-scan-0001' });
  assert.equal(r.complete, true);
});

test('input bounds are refused before any state changes', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  const bad = (over) => ({ projectId: 'p', scanId: 'scan-bounds-01', index: 0, total: 1, complete: true,
    totalEntries: 0, entries: [], ...over });
  const refuse = (over) => assert.rejects(() => ni.scanNoteChunk(U, bad(over)),
    (err) => err.code === 'VALIDATION_FAILED' && err.status === 400);
  await refuse({ scanId: 'short' });
  await refuse({ index: 1, total: 1 });
  await refuse({ total: 101 });
  await refuse({ complete: false, prune: true, totalEntries: undefined });
  await refuse({ entries: Array.from({ length: 501 }, (_, i) => ({ noteKey: `k${i}.md`, contentHash: 'h' })), totalEntries: 501 });
  await refuse({ entries: [{ noteKey: '../escape.md', contentHash: 'h' }] });
  await refuse({ keep: ['../escape.md'] });
  await refuse({ allowEmpty: 'yes' });
});

test('open scans are capped per user and never touch another user', async () => {
  U = newUser(); V = newUser();
  ni.resetNoteIndexScans();
  seedRows(V, ['v-only.md']);
  // distinct projects, so the per-project abandonment does not apply
  for (let i = 0; i < ni.MAX_OPEN_SCANS; i += 1) {
    await ni.scanNoteChunk(U, { projectId: `proj-${i}`, scanId: `open-scan-0${i}`, index: 0, total: 2, complete: false, entries: [] });
  }
  await assert.rejects(() => ni.scanNoteChunk(U, { projectId: 'proj-9', scanId: 'open-scan-09', index: 0, total: 2, complete: false, entries: [] }),
    refusal('SCAN_LIMIT', 429));
  await ni.scanNoteChunk(V, { projectId: 'p', scanId: 'v-scan-000001', index: 0, total: 1, complete: true, prune: true, totalEntries: 0, entries: [], allowEmpty: true });
  assert.deepEqual(conn.prepare('SELECT note_key FROM note_index WHERE user_id = ? AND project_id = ?').all(V, 'p').map((r) => r.note_key), []);
});

test('the shared quick rebuild: an empty reconcile with allowEmpty clears a project, without it is refused', () => {
  U = newUser();
  seedRows(U, ['z-1.md']);
  assert.throws(() => ni.reconcileNotes(U, { projectId: 'p', manifest: [], prune: true }), refusal('EMPTY_MANIFEST_REFUSED'));
  const r = ni.reconcileNotes(U, { projectId: 'p', manifest: [], prune: true, allowEmpty: true });
  assert.equal(r.pruned, 1);
});

test('a 20 000-note library is sent in 40 chunks and prunes only its own stale rows', async () => {
  U = newUser();
  ni.resetNoteIndexScans();
  const all = Array.from({ length: 20000 }, (_, i) => `lib/n${String(i).padStart(5, '0')}.md`);
  seedRows(U, all);
  const manifest = all.slice(0, 19998);
  const r = await sendScan(U, manifest, { prune: true, scanId: 'scan-big-00001' });
  assert.equal(r.total, 40);
  assert.equal(r.pruned, 2);
  assert.equal(rowKeys(U).length, 19998);
});
