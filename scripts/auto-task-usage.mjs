#!/usr/bin/env node
// Which Auto Tasks does THIS machine actually run? Read-only, counts only.
//
// The user runs this on their own machine. It prints, per task name: how many
// runs, the last run date and the success rate. It never prints a log line,
// summary, prompt, issue text, project name or path; it opens every file
// read-only and writes nothing.
//
//   node scripts/auto-task-usage.mjs [--history <auto-task-runs.json>]
//                                    [--db <data.db>] [--json]
//
// Two independent sources (each is skipped, with a one-line note, when absent):
//   1. The Mac app's run history (`auto-task-runs.json`, newest 200 runs across
//      ALL tasks, one record per run with status success|failed|cancelled|
//      skipped and a trigger manual|cron|pipeline|phone). This is the only
//      source that covers every task and has a success rate. Default path:
//      ~/Library/Application Support/llm-ide/auto-task-runs.json
//   2. The server database usage ledger (`usage_ledger`, source 'auto-task',
//      endpoint 'auto-task:<task>'): only the tasks that run an AI CLI are
//      metered there (review-code, review-doc, review-conflicts, generate-doc,
//      update-issues, issue implementation, custom tasks). It has no success
//      flag, so it reports runs and the last date only. DB path, first match:
//      --db, LLMIDE_DB_PATH, $LLMIDE_DATA_DIR/data.db, the repo kb/data.db.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every built-in task id (AutoTask.swift) so a never-run task still shows as 0. */
export const BUILT_IN_TASKS = [
  'sourceUpdate', 'sourcesToIssue', 'implementIssues', 'reviewMerge', 'reviewCode',
  'reviewDoc', 'reviewConflicts', 'regression', 'generateKnowledge', 'generateDoc',
  'updateIssues', 'updatePlanStatus', 'loopEngineering',
];

/** Ledger endpoints use the log suffix (AutoTask.logSuffix), not the enum id. */
const SUFFIX_TO_ID = {
  'source-update': 'sourceUpdate',
  'sources-to-issue': 'sourcesToIssue',
  'implement-issues': 'implementIssues',
  'review-merge': 'reviewMerge',
  'review-code': 'reviewCode',
  'review-doc': 'reviewDoc',
  'review-conflicts': 'reviewConflicts',
  regression: 'regression',
  knowledge: 'generateKnowledge',
  'generate-doc': 'generateDoc',
  'update-issues': 'updateIssues',
  'update-plan-status': 'updatePlanStatus',
  'loop-engineering': 'loopEngineering',
};

export function defaultHistoryPath(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'llm-ide', 'auto-task-runs.json');
}

export function resolveDbPath({ db, env = process.env, root = ROOT } = {}) {
  if (db) return path.resolve(db);
  if (env.LLMIDE_DB_PATH) return path.resolve(env.LLMIDE_DB_PATH);
  if (env.LLMIDE_DATA_DIR) return path.join(path.resolve(env.LLMIDE_DATA_DIR), 'data.db');
  return path.join(root, 'kb', 'data.db');
}

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** Task name for a ledger endpoint, or null when it is not an auto-task one. */
export function taskFromEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('auto-task:')) return null;
  const rest = endpoint.slice('auto-task:'.length);
  if (/^issue-\d+$/.test(rest)) return 'implementIssues';
  return SUFFIX_TO_ID[rest] ?? `custom:${rest}`;
}

/**
 * Per-task counts from the Mac run history file. Counts, dates and rates only:
 * the record's summary, label, project and log name are never read.
 * Returns null when the file is absent or unreadable.
 */
export function readHistory(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : null;
  if (!records) return null;
  const by = new Map();
  for (const r of records) {
    if (!r || typeof r.taskId !== 'string') continue;
    const row = by.get(r.taskId) ?? {
      runs: 0, success: 0, failed: 0, cancelled: 0, skipped: 0, last: null,
      byTrigger: { manual: 0, cron: 0, pipeline: 0, phone: 0 },
    };
    row.runs += 1;
    if (r.status in row) row[r.status] += 1;
    if (r.trigger in row.byTrigger) row.byTrigger[r.trigger] += 1;
    const t = Date.parse(r.finishedAt ?? r.startedAt);
    if (Number.isFinite(t) && (row.last == null || t > row.last)) row.last = t;
    by.set(r.taskId, row);
  }
  return { total: records.length, by };
}

/** Per-task run counts and last date from the usage ledger (read-only). Null when unavailable. */
export function readLedger(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  let Database;
  try {
    Database = createRequire(path.join(ROOT, 'extension', 'package.json'))('better-sqlite3');
  } catch {
    return null;
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT endpoint, COUNT(*) AS n, MAX(ts) AS last
           FROM usage_ledger WHERE source = 'auto-task' GROUP BY endpoint`,
      )
      .all();
    const by = new Map();
    for (const r of rows) {
      const name = taskFromEndpoint(r.endpoint);
      if (!name) continue;
      const row = by.get(name) ?? { runs: 0, last: null };
      row.runs += r.n;
      const t = Date.parse(String(r.last).replace(' ', 'T'));
      if (Number.isFinite(t) && (row.last == null || t > row.last)) row.last = t;
      by.set(name, row);
    }
    return { by };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* read-only handle */ }
  }
}

/** Merge both sources into one row per task (built-ins first, then custom). */
export function summarize({ historyPath, dbPath }) {
  const history = historyPath ? readHistory(historyPath) : null;
  const ledger = dbPath ? readLedger(dbPath) : null;
  const names = new Set(BUILT_IN_TASKS);
  for (const n of history?.by.keys() ?? []) names.add(n);
  for (const n of ledger?.by.keys() ?? []) names.add(n);
  const rows = [...names].map((task) => {
    const h = history?.by.get(task);
    const l = ledger?.by.get(task);
    const finished = h ? h.success + h.failed : 0;
    return {
      task,
      historyRuns: h?.runs ?? 0,
      lastRun: iso(h?.last),
      successRate: finished > 0 ? Math.round((h.success / finished) * 100) : null,
      phoneRuns: h?.byTrigger.phone ?? 0,
      cronRuns: h?.byTrigger.cron ?? 0,
      ledgerRuns: l?.runs ?? 0,
      ledgerLast: iso(l?.last),
    };
  });
  rows.sort((a, b) => (b.historyRuns + b.ledgerRuns) - (a.historyRuns + a.ledgerRuns) || a.task.localeCompare(b.task));
  return {
    historyFound: history != null,
    historyTotal: history?.total ?? 0,
    ledgerFound: ledger != null,
    rows,
  };
}

export function formatReport(s) {
  const lines = [];
  lines.push(s.historyFound
    ? `Mac run history: ${s.historyTotal} run(s) on file (the app keeps only the newest 200 across all tasks).`
    : 'Mac run history: not found (pass --history <auto-task-runs.json>).');
  lines.push(s.ledgerFound
    ? 'Server usage ledger: read (CLI-backed tasks only, no success flag).'
    : 'Server usage ledger: not found (pass --db <data.db>, or set LLMIDE_DB_PATH / LLMIDE_DATA_DIR).');
  lines.push('');
  const head = ['task', 'runs', 'last run', 'success%', 'cron', 'phone', 'ledger runs', 'ledger last'];
  const body = s.rows.map((r) => [
    r.task, String(r.historyRuns), r.lastRun ?? '-', r.successRate == null ? '-' : String(r.successRate),
    String(r.cronRuns), String(r.phoneRuns), String(r.ledgerRuns), r.ledgerLast ?? '-',
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => cells.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  lines.push(fmt(head), fmt(w.map((n) => '-'.repeat(n))), ...body.map(fmt));
  lines.push('', 'A task with 0 runs here has not run on this machine in the retained window.');
  return lines.join('\n');
}

export function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') out.json = true;
    else if (argv[i] === '--history') out.history = argv[++i];
    else if (argv[i] === '--db') out.db = argv[++i];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const s = summarize({
      historyPath: args.history ? path.resolve(args.history) : defaultHistoryPath(),
      dbPath: resolveDbPath({ db: args.db }),
    });
    console.log(args.json ? JSON.stringify(s, null, 2) : formatReport(s));
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(2);
  }
}
