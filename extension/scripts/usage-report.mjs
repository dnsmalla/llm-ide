#!/usr/bin/env node
// Where the model tokens go, from the usage ledger — the report behind the
// 2026-10-05 finding that the Loop's headless agent steps (not chat) are most of
// the cache-read volume and that a few long runs dominate it.
//
//   node scripts/usage-report.mjs [--db kb/data.db] [--days 14]
//
// Read-only: the database is COPIED to a temp file first, so a running server's
// WAL is never touched. Cost on the Agent engine is (context size) x (round
// trips), because every turn re-reads the context — so besides the token split
// this prints the distribution of a step's size and, from migration 0039, how
// many round trips it took and how many hit the turn cap.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIB = 1_000_000;

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/**
 * Summarize ledger rows for one endpoint.
 *
 * @param {Array<{cache_read_tokens:number|null, turns:number|null, stop_reason:string|null}>} rows
 * @param {{turnCap?: number}} [options] — a run whose stop reason is
 *   `error_max_turns`, or whose turns reached `turnCap`, counts as capped.
 * @returns {{runs:number, cacheReadM:number, median:number, p90:number, max:number,
 *   topFifthShare:number, turns:null|{known:number, median:number, p90:number, max:number, capped:number}}}
 */
export function summarizeRuns(rows, { turnCap = 60 } = {}) {
  const reads = rows.map((r) => Number(r.cache_read_tokens) || 0).sort((a, b) => a - b);
  const total = reads.reduce((sum, v) => sum + v, 0);
  const topCount = Math.max(1, Math.ceil(reads.length / 5));
  const top = reads.slice(-topCount).reduce((sum, v) => sum + v, 0);
  const withTurns = rows.filter((r) => r.turns != null);
  const turnList = withTurns.map((r) => Number(r.turns)).sort((a, b) => a - b);
  return {
    runs: rows.length,
    cacheReadM: total / MIB,
    median: quantile(reads, 0.5),
    p90: quantile(reads, 0.9),
    max: reads.length ? reads[reads.length - 1] : 0,
    topFifthShare: total ? top / total : 0,
    turns: turnList.length ? {
      known: turnList.length,
      median: quantile(turnList, 0.5),
      p90: quantile(turnList, 0.9),
      max: turnList[turnList.length - 1],
      capped: withTurns.filter((r) => r.stop_reason === 'error_max_turns' || Number(r.turns) >= turnCap).length,
    } : null,
  };
}

function parseArgs(argv) {
  const out = { db: null, days: 14 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--days') out.days = Math.max(1, Number(argv[++i]) || 14);
  }
  return out;
}

async function main() {
  const { default: Database } = await import('better-sqlite3');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const args = parseArgs(process.argv.slice(2));
  const source = args.db || path.join(here, '..', '..', 'kb', 'data.db');
  if (!fs.existsSync(source)) { console.error(`no database at ${source}`); process.exit(1); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-report-'));
  const copy = path.join(dir, 'copy.db');
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, copy + suffix);
  }
  const db = new Database(copy, { readonly: true });
  try {
    const hasTurns = db.prepare("SELECT 1 FROM pragma_table_info('usage_ledger') WHERE name = 'turns'").get();
    const select = `SELECT endpoint, model, cache_read_tokens, cache_creation_tokens, output_tokens,
                           ${hasTurns ? 'turns, stop_reason' : 'NULL AS turns, NULL AS stop_reason'}
                    FROM usage_ledger WHERE ts >= datetime('now','localtime', ?)`;
    const rows = db.prepare(select).all(`-${args.days} day`);
    console.log(`Usage ledger, last ${args.days} days (${rows.length} rows)\n`);
    const byEndpoint = new Map();
    for (const row of rows) {
      const key = row.endpoint || '(cli)';
      if (!byEndpoint.has(key)) byEndpoint.set(key, []);
      byEndpoint.get(key).push(row);
    }
    for (const [endpoint, list] of [...byEndpoint].sort((a, b) => b[1].length - a[1].length)) {
      const s = summarizeRuns(list);
      console.log(`${endpoint}`);
      console.log(`  rows ${s.runs}   cache-read ${s.cacheReadM.toFixed(2)}M   median ${Math.round(s.median / 1000)}k   p90 ${Math.round(s.p90 / 1000)}k   max ${Math.round(s.max / 1000)}k   top-20% share ${(100 * s.topFifthShare).toFixed(0)}%`);
      console.log(s.turns
        ? `  turns (${s.turns.known} rows): median ${s.turns.median}   p90 ${s.turns.p90}   max ${s.turns.max}   at the cap ${s.turns.capped}`
        : '  turns: not recorded yet (rows written before migration 0039)');
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
