// Explicit, bounded maintenance for data.db: FTS5 segment merging and
// incremental vacuum. Deliberately NOT on a request or boot path, and never a
// full VACUUM.
//
// Why bounded: better-sqlite3 is synchronous, and the server serves chat and
// health from the same event loop. A single unbounded `'optimize'` on a large
// `search` index, or a full `VACUUM`, would stall every request for seconds to
// minutes and hold a write lock for the whole time. Instead:
//   - FTS5 `'merge'` command, at most `mergePages` pages per statement, repeated
//     until one segment remains, `maxPages` pages in total or `maxMs` elapsed;
//   - `PRAGMA incremental_vacuum(N)`, at most `vacuumPages` pages per statement,
//     only when the database is already in INCREMENTAL auto-vacuum mode;
//   - an `await` (a macrotask) between batches so the event loop can serve.
// Each statement is its own short write transaction. Running it again is safe:
// one segment and an empty freelist make it a no-op.
//
// The one-time switch to `PRAGMA auto_vacuum = INCREMENTAL` only takes effect
// after a full VACUUM, so this module never performs it. It reports
// `vacuum.skipped: 'not-incremental'` and the docs explain the offline step.

import fs from 'fs';
import { config } from '../core/config.mjs';
import { getDb } from './db.mjs';

export const FTS_TABLE = 'search';
export const DEFAULT_MERGE_PAGES = 500;
export const DEFAULT_MAX_PAGES = 4000;
export const DEFAULT_MAX_MS = 5000;
// A full FTS5 'optimize' is only safe to run automatically on a small index; a
// large one uses the bounded 'merge' path above. ~8000 pages is a few tens of MB.
export const DEFAULT_OPTIMIZE_MAX_PAGES = 8000;

const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

function fileBytes(file) {
  let total = 0;
  for (const s of ['', '-wal']) {
    try { total += fs.statSync(file + s).size; } catch { /* absent */ }
  }
  return total;
}

/** Number of FTS5 segments, or null when `search` is not an FTS5 table. */
function ftsSegments(db) {
  try {
    return db.prepare('SELECT COUNT(DISTINCT segid) AS n FROM search_idx').get().n;
  } catch {
    return null;
  }
}

/**
 * Run one bounded maintenance pass.
 *
 * @param {object} [opts]
 * @param {import('better-sqlite3').Database} [opts.db] open handle (default: the server's getDb())
 * @param {string} [opts.file] the DB file, for byte reporting (default: config.dbPath)
 * @param {number} [opts.maxPages] total FTS pages to merge and vacuum pages to free
 * @param {number} [opts.optimizeMaxPages] run a full FTS 'optimize' only up to this many DB pages
 * @param {number} [opts.mergePages] pages per FTS merge statement
 * @param {number} [opts.vacuumPages] pages per incremental_vacuum statement
 * @param {number} [opts.maxMs] wall-clock budget for this pass
 * @param {() => boolean} [opts.inFlight] true while a turn/agent run is active
 * @param {() => number} [opts.now] clock (tests)
 * @param {() => Promise<void>} [opts.yieldFn] event-loop yield (tests)
 * @returns {Promise<object>} the report; `ok` is false only for a real failure
 */
export async function runMaintenance({
  db = null, file = config.dbPath, maxPages = DEFAULT_MAX_PAGES,
  optimizeMaxPages = DEFAULT_OPTIMIZE_MAX_PAGES,
  mergePages = DEFAULT_MERGE_PAGES, vacuumPages = DEFAULT_MERGE_PAGES, maxMs = DEFAULT_MAX_MS,
  inFlight = () => false, now = () => Date.now(), yieldFn = yieldToEventLoop,
} = {}) {
  const handle = db ?? getDb();
  const started = now();
  const pages = Math.max(1, Math.floor(Number(maxPages) || DEFAULT_MAX_PAGES));
  const perMerge = Math.max(1, Math.min(pages, Math.floor(Number(mergePages) || DEFAULT_MERGE_PAGES)));
  const perVacuum = Math.max(1, Math.min(pages, Math.floor(Number(vacuumPages) || DEFAULT_MERGE_PAGES)));
  const budget = Math.max(1, Math.floor(Number(maxMs) || DEFAULT_MAX_MS));
  const optimizeCap = Math.max(1, Math.floor(Number(optimizeMaxPages) || DEFAULT_OPTIMIZE_MAX_PAGES));
  const report = {
    ok: true,
    bounded: true,
    maxPages: pages,
    maxMs: budget,
    file,
    bytesBefore: fileBytes(file),
    fts: { attempted: false, skipped: null, mode: null, segmentsBefore: null, segmentsAfter: null, pagesMerged: 0, stopped: null },
    vacuum: { attempted: false, skipped: null, autoVacuum: null, pagesBefore: 0, pagesFreed: 0, stopped: null },
    notes: [],
    durationMs: 0,
  };
  const remaining = () => budget - (now() - started);

  // --- FTS5 segment merge (the bounded form of 'optimize') ---------------
  const hasSearch = Boolean(handle.prepare("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = ?").get(FTS_TABLE));
  if (!hasSearch) {
    report.fts.skipped = 'no-search-table';
  } else {
    const before = ftsSegments(handle);
    report.fts.attempted = true;
    report.fts.segmentsBefore = before;
    if (before === null) {
      report.fts.skipped = 'no-fts-index';
    } else {
      let merged = 0;
      let current = before;
      while (current > 1 && merged < pages) {
        if (remaining() <= 0) { report.fts.stopped = 'time-budget'; break; }
        if (inFlight()) { report.fts.stopped = 'busy'; break; }
        const n = Math.min(perMerge, pages - merged);
        try {
          handle.prepare(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}, rank) VALUES('merge', ?)`).run(n);
        } catch (err) {
          report.ok = false;
          report.fts.error = err.message;
          break;
        }
        merged += n;
        const next = ftsSegments(handle);
        if (next === null || next >= current) { current = next ?? current; break; } // no progress
        current = next;
        await yieldFn();
      }
      report.fts.pagesMerged = merged;
      report.fts.segmentsAfter = current;
      if (current > 1 && !report.fts.stopped && merged >= pages) report.fts.stopped = 'page-budget';
      report.fts.mode = merged > 0 ? 'merge' : 'none';
      // FTS5's merge command leaves at most two segments. For a SMALL index, a
      // full 'optimize' is quick and bounded by the page cap below; for a large
      // one it would be an unbounded write, so the merge result is kept.
      const pageCount = handle.pragma('page_count', { simple: true });
      if (current > 1 && remaining() > 0 && pageCount <= optimizeCap && !inFlight()) {
        try {
          handle.prepare(`INSERT INTO ${FTS_TABLE}(${FTS_TABLE}) VALUES('optimize')`).run();
          report.fts.mode = 'optimize';
          report.fts.segmentsAfter = ftsSegments(handle);
        } catch (err) {
          report.ok = false;
          report.fts.error = err.message;
        }
      }
    }
  }

  // --- incremental vacuum (never a full VACUUM) ---------------------------
  const auto = handle.pragma('auto_vacuum', { simple: true });
  const freeBefore = handle.pragma('freelist_count', { simple: true });
  report.vacuum.autoVacuum = auto;
  report.vacuum.pagesBefore = freeBefore;
  if (auto !== 2) {
    report.vacuum.skipped = 'not-incremental';
    report.notes.push('auto_vacuum is not INCREMENTAL; freeing pages needs a one-time offline VACUUM (not run automatically)');
  } else if (freeBefore <= 0) {
    report.vacuum.skipped = 'no-free-pages';
  } else {
    report.vacuum.attempted = true;
    let freed = 0;
    let freeNow = freeBefore;
    while (freeNow > 0 && freed < pages) {
      if (remaining() <= 0) { report.vacuum.stopped = 'time-budget'; break; }
      if (inFlight()) { report.vacuum.stopped = 'busy'; break; }
      const n = Math.min(perVacuum, pages - freed);
      try {
        handle.pragma(`incremental_vacuum(${n})`);
      } catch (err) {
        report.ok = false;
        report.vacuum.error = err.message;
        break;
      }
      freed += n;
      const next = handle.pragma('freelist_count', { simple: true });
      if (next >= freeNow) { freeNow = next; break; } // no progress
      freeNow = next;
      await yieldFn();
    }
    report.vacuum.pagesFreed = freeBefore - freeNow;
    if (freeNow > 0 && !report.vacuum.stopped && freed >= pages) report.vacuum.stopped = 'page-budget';
  }

  report.bytesAfter = fileBytes(file);
  report.durationMs = now() - started;
  return report;
}
