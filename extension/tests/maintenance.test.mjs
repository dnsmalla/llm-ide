// Bounded maintenance for data.db (kb/maintenance.mjs): FTS5 segment merge /
// small-index optimize and incremental vacuum. Temp DBs only.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMaintenance } from '../kb/maintenance.mjs';

let dir;
let file;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-maint-'));
  file = path.join(dir, 'data.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeDb({ incremental = true, fts = true, segments = 10 } = {}) {
  const db = new Database(file);
  if (incremental) db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT);');
  db.prepare("INSERT INTO schema_migrations VALUES (69, 'test')").run();
  if (fts) {
    db.exec('CREATE VIRTUAL TABLE search USING fts5(title, body);');
    // One transaction per row keeps many FTS segments (automerge is not a merge).
    for (let i = 0; i < segments * 20; i += 1) {
      db.prepare('INSERT INTO search(title, body) VALUES (?, ?)').run(`t${i}`, `body number ${i}`);
    }
  }
  return db;
}

const segments = (db) => db.prepare('SELECT COUNT(DISTINCT segid) AS n FROM search_idx').get().n;

test('merges FTS segments and optimizes a small index; a second pass is a no-op', async () => {
  const db = makeDb();
  try {
    const before = segments(db);
    assert.ok(before > 1);
    const first = await runMaintenance({ db, file, maxPages: 1000, maxMs: 10_000 });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.bounded, true);
    assert.equal(first.fts.attempted, true);
    assert.equal(first.fts.segmentsBefore, before);
    assert.equal(first.fts.segmentsAfter, 1, JSON.stringify(first.fts));
    assert.equal(first.fts.mode, 'optimize');

    const second = await runMaintenance({ db, file, maxPages: 1000, maxMs: 10_000 });
    assert.equal(second.ok, true);
    assert.equal(second.fts.segmentsBefore, 1);
    assert.equal(second.fts.segmentsAfter, 1);
    assert.equal(second.vacuum.pagesFreed, 0);
  } finally { db.close(); }
});

test('the page budget bounds one pass (no unbounded optimize)', async () => {
  const db = makeDb({ segments: 40 });
  try {
    const before = segments(db);
    const r = await runMaintenance({ db, file, maxPages: 10, optimizeMaxPages: 1, maxMs: 10_000 });
    assert.equal(r.ok, true);
    assert.ok(r.fts.pagesMerged <= 10, JSON.stringify(r.fts));
    assert.ok(r.fts.segmentsAfter <= before);
    assert.equal(r.fts.mode, 'merge');
    assert.ok(['page-budget', 'time-budget', 'no-progress'].includes(r.fts.stopped) || r.fts.segmentsAfter <= 2);
  } finally { db.close(); }
});

test('a large index skips the full optimize and keeps the merge result', async () => {
  const db = makeDb({ segments: 4 });
  try {
    // Pretend the DB is bigger than the optimize cap.
    const r = await runMaintenance({ db, file, maxPages: 1000, optimizeMaxPages: 1, maxMs: 10_000 });
    assert.equal(r.ok, true);
    assert.equal(r.fts.mode, 'merge');
    assert.ok(r.fts.segmentsAfter >= 1);
  } finally { db.close(); }
});

test('incremental vacuum frees pages on an INCREMENTAL database and is repeatable', async () => {
  const db = makeDb({ incremental: true, fts: false });
  try {
    db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, body BLOB);');
    for (let i = 0; i < 1000; i += 1) db.prepare('INSERT INTO big(body) VALUES (?)').run(Buffer.alloc(2000, i % 256));
    db.exec('DELETE FROM big');
    const freeBefore = db.pragma('freelist_count', { simple: true });
    assert.ok(freeBefore > 0);
    const r = await runMaintenance({ db, file, maxPages: 2000, maxMs: 10_000 });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.vacuum.autoVacuum, 2);
    assert.equal(r.vacuum.attempted, true);
    assert.ok(r.vacuum.pagesFreed > 0);
    assert.ok(db.pragma('freelist_count', { simple: true }) < freeBefore);
    const again = await runMaintenance({ db, file, maxPages: 400, maxMs: 10_000 });
    assert.equal(again.ok, true);
    assert.equal(again.vacuum.pagesFreed, 0);
  } finally { db.close(); }
});

test('a database that is not INCREMENTAL reports the offline step instead of running a full VACUUM', async () => {
  const db = makeDb({ incremental: false, fts: false });
  try {
    const r = await runMaintenance({ db, file });
    assert.equal(r.ok, true);
    assert.equal(r.vacuum.skipped, 'not-incremental');
    assert.ok(r.notes.some((n) => /one-time offline VACUUM/.test(n)));
    assert.equal(r.fts.skipped, 'no-search-table');
  } finally { db.close(); }
});

test('an in-flight turn stops the pass between batches', async () => {
  const db = makeDb({ segments: 10 });
  try {
    const r = await runMaintenance({ db, file, maxPages: 1000, maxMs: 10_000, inFlight: () => true });
    assert.equal(r.ok, true);
    assert.equal(r.fts.stopped, 'busy');
    assert.equal(r.fts.pagesMerged, 0);
  } finally { db.close(); }
});
