// Explicit, bounded maintenance for data.db (FTS5 segment merge + incremental
// vacuum). This is for a STOPPED server: the single-writer rule says a second
// Node process must never write the same SQLite file as the live core. The
// probe below refuses while any other connection has a write lock.
//
//   node scripts/maintain-db.mjs                 # the configured data.db
//   node scripts/maintain-db.mjs --pages 8000 --ms 15000 --json
//   LLMIDE_DATA_DIR=... node scripts/maintain-db.mjs
//   node scripts/maintain-db.mjs --db /path/to/data.db
//
// Prefer POST /admin/maintenance while the app runs: it is the same engine in
// the core's own process, so there is no second writer. It is admin-only and
// takes the same caps from ?pages=, ?mergePages=, ?vacuumPages=, ?ms=.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

import { config } from '../core/config.mjs';
import {
  runMaintenance, DEFAULT_MERGE_PAGES, DEFAULT_MAX_PAGES, DEFAULT_MAX_MS,
} from '../kb/maintenance.mjs';

function parseArgs(argv) {
  const out = {
    dbPath: config.dbPath,
    maxPages: DEFAULT_MAX_PAGES,
    mergePages: DEFAULT_MERGE_PAGES,
    vacuumPages: DEFAULT_MERGE_PAGES,
    maxMs: DEFAULT_MAX_MS,
    json: false,
    help: false,
  };
  const int = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1) throw new Error(`${name} must be a positive integer`);
    return Math.floor(n);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--db') out.dbPath = argv[++i] ?? '';
    else if (a === '--pages') out.maxPages = int(argv[++i], '--pages');
    else if (a === '--merge-pages') out.mergePages = int(argv[++i], '--merge-pages');
    else if (a === '--vacuum-pages') out.vacuumPages = int(argv[++i], '--vacuum-pages');
    else if (a === '--ms') out.maxMs = int(argv[++i], '--ms');
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!out.dbPath) throw new Error('--db requires a value');
  return out;
}

/** Refuse while another process has a write transaction on the file. */
function assertQuiescent(file) {
  if (!fs.existsSync(file)) throw new Error(`database not found: ${file}`);
  let db = null;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 0 });
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  } catch (err) {
    throw new Error(`the database is in use by another process (${err.code ?? err.message}); stop the server/desktop core first`);
  } finally {
    try { if (db && db.open) db.close(); } catch { /* already closed */ }
  }
}

function human(report, file) {
  const lines = [
    `LLM-IDE database maintenance: ${file}`,
    `FTS: ${report.fts.skipped ? `skipped (${report.fts.skipped})` : `segments ${report.fts.segmentsBefore} -> ${report.fts.segmentsAfter}, ${report.fts.pagesMerged} pages merged${report.fts.stopped ? ` (${report.fts.stopped})` : ''}`}`,
    `Vacuum: ${report.vacuum.skipped ? `skipped (${report.vacuum.skipped})` : `${report.vacuum.pagesFreed} pages freed${report.vacuum.stopped ? ` (${report.vacuum.stopped})` : ''}`}`,
    `Bytes: ${report.bytesBefore} -> ${report.bytesAfter}; ${report.durationMs} ms`,
  ];
  for (const n of report.notes ?? []) lines.push(`Note: ${n}`);
  if (!report.ok) lines.push('FAILED');
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (args.help) {
    process.stdout.write([
      'Usage: node scripts/maintain-db.mjs [--db <path>] [--pages N] [--merge-pages N] [--vacuum-pages N] [--ms N] [--json]',
      '',
      'Bounded FTS5 segment merge and incremental vacuum for a STOPPED server.',
      `Defaults: --pages ${DEFAULT_MAX_PAGES} --merge-pages ${DEFAULT_MERGE_PAGES} --vacuum-pages ${DEFAULT_MERGE_PAGES} --ms ${DEFAULT_MAX_MS}`,
      'The live app should use POST /admin/maintenance instead (same engine, no second writer).',
      '',
    ].join('\n'));
    return 0;
  }
  const file = path.resolve(args.dbPath);
  try {
    assertQuiescent(file);
    const db = new Database(file, { fileMustExist: true });
    let report;
    try {
      report = await runMaintenance({
        db, file, maxPages: args.maxPages, mergePages: args.mergePages,
        vacuumPages: args.vacuumPages, maxMs: args.maxMs,
      });
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    if (args.json) console.log(JSON.stringify(report));
    else console.log(human(report, file));
    return report.ok ? 0 : 1;
  } catch (err) {
    if (args.json) console.log(JSON.stringify({ ok: false, error: err.message }));
    else console.error(err.message);
    return 1;
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = await main();
}
