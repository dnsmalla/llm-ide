#!/usr/bin/env node
// Retrieval report: does the code graph actually save tokens?
//
//   npm run report:retrieval -- [--days 7]
//
// Read-only. Opens the DB with readonly: true (never migrates or checkpoints).
// Safe to run while the server is up: readonly handles don't block the writer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.LLMIDE_DB_PATH || path.resolve(__dirname, '..', '..', 'kb', 'data.db');

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;

const { summarizeToolEventsOn } = await import('../kb/tool-events-summary.mjs');

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Failed to open DB: ${err.message}`);
  process.exit(1);
}

let s;
try {
  s = summarizeToolEventsOn(db, null, { days });
} catch (err) {
  if (/no such table: (turn_tool_events|usage_ledger)/.test(err.message)) {
    console.log('No tool accounting yet: the backend has not run migration 0035. Restart the backend on this code, then re-run.');
    db.close();
    process.exit(0);
  }
  throw err;
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const tok = (t) => (t
  ? `${t.turns} turns · input ${t.input} · cache-read ${t.cacheRead} · cache-write ${t.cacheCreation} · output ${t.output}`
  : 'no data');

console.log(`Retrieval report — last ${days} day(s) — ${dbPath}\n`);
console.log(`Turns with tool calls:        ${s.turns}`);
console.log(`Turns using find-code:        ${s.turnsWithFindCode} (${pct(s.turnsWithFindCode, s.turns)})`);
console.log(`find-code before Read/Grep:   ${s.findCodeFirstTurns} (${pct(s.findCodeFirstTurns, s.turnsWithFindCode)} of find-code turns)\n`);
console.log('Calls by tool (avg result chars):');
for (const r of s.byTool) console.log(`  ${r.tool.padEnd(24)} ${String(r.calls).padStart(6)}   ~${r.avgChars} chars`);
console.log(`\nAvg tokens/turn WITH find-code:    ${tok(s.tokensWithFindCode)}`);
console.log(`Avg tokens/turn WITHOUT find-code: ${tok(s.tokensWithoutFindCode)}`);
console.log('\nCorrelation, not causation: turns differ in task size. Compare like-for-like modes before concluding.');
db.close();
