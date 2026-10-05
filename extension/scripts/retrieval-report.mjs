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
const rawDays = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;
// Same clamp the summary applies, so the header states the window actually used.
const days = Math.max(1, Math.min(365, Math.trunc(rawDays)));

const { summarizeToolEventsOn } = await import('../kb/tool-events-summary.mjs');

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Failed to open DB: ${err.message}`);
  process.exit(1);
}

let s;
let legacy;
let loop;
try {
  s = summarizeToolEventsOn(db, null, { days });
  legacy = summarizeToolEventsOn(db, null, { days, engine: 'legacy' });
  loop = summarizeToolEventsOn(db, null, { days, engine: 'loop' });
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

console.log(`Retrieval report (v2 engine) — last ${days} day(s) — ${dbPath}\n`);
console.log(`Turns with tool calls:        ${s.turns}`);
console.log(`Turns using find-code:        ${s.turnsWithFindCode} (${pct(s.turnsWithFindCode, s.turns)})`);
console.log(`find-code before Read/Grep:   ${s.findCodeFirstTurns} (${pct(s.findCodeFirstTurns, s.turnsWithFindCode)} of find-code turns)\n`);
console.log('Calls by tool (avg result chars):');
for (const r of s.byTool) console.log(`  ${r.tool.padEnd(24)} ${String(r.calls).padStart(6)}   ~${r.avgChars} chars`);
console.log(`\nAvg tokens/turn WITH find-code:    ${tok(s.tokensWithFindCode)}`);
console.log(`Avg tokens/turn WITHOUT find-code: ${tok(s.tokensWithoutFindCode)}`);
const push = legacy.byTool.find((r) => r.tool === 'memory_push');
console.log(`\nLegacy engine: ${legacy.turns} turn(s) with tool events; avg memory_push ${push ? `~${push.avgChars} chars` : 'n/a'} (not in the v2 figures above).`);
console.log(`\nLoop agent steps with tool calls: ${loop.turns}; using find-code: ${loop.turnsWithFindCode} (${pct(loop.turnsWithFindCode, loop.turns)}); find-code before Read/Grep: ${loop.findCodeFirstTurns}`);
console.log(`  Avg tokens/step WITH find-code:    ${tok(loop.tokensWithFindCode)}`);
console.log(`  Avg tokens/step WITHOUT find-code: ${tok(loop.tokensWithoutFindCode)}`);
for (const r of loop.byTool) console.log(`  ${r.tool.padEnd(24)} ${String(r.calls).padStart(6)}   ~${r.avgChars} chars`);
console.log('\nCorrelation, not causation: turns differ in task size. Compare like-for-like modes before concluding.');
db.close();
