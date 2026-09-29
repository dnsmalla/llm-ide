#!/usr/bin/env node
// Retrieval report: does the code graph actually save tokens?
//
//   npm run report:retrieval -- [--days 7]
//
// Read-only. Points LLMIDE_DB_PATH at the live DB unless already set, and
// opens it through the normal kb layer (which only reads here). Safe to run
// while the server is up: WAL readers never block the writer.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.LLMIDE_DB_PATH ||= path.resolve(__dirname, '..', '..', 'kb', 'data.db');

const daysArg = process.argv.indexOf('--days');
const days = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;

const { summarizeToolEvents, closeDb } = await import('../kb/db.mjs');
const s = summarizeToolEvents(null, { days });

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');
const tok = (t) => (t
  ? `${t.turns} turns · input ${t.input} · cache-read ${t.cacheRead} · cache-write ${t.cacheCreation} · output ${t.output}`
  : 'no data');

console.log(`Retrieval report — last ${days} day(s) — ${process.env.LLMIDE_DB_PATH}\n`);
console.log(`Turns with tool calls:        ${s.turns}`);
console.log(`Turns using find-code:        ${s.turnsWithFindCode} (${pct(s.turnsWithFindCode, s.turns)})`);
console.log(`find-code before Read/Grep:   ${s.findCodeFirstTurns} (${pct(s.findCodeFirstTurns, s.turnsWithFindCode)} of find-code turns)\n`);
console.log('Calls by tool (avg result chars):');
for (const r of s.byTool) console.log(`  ${r.tool.padEnd(24)} ${String(r.calls).padStart(6)}   ~${r.avgChars} chars`);
console.log(`\nAvg tokens/turn WITH find-code:    ${tok(s.tokensWithFindCode)}`);
console.log(`Avg tokens/turn WITHOUT find-code: ${tok(s.tokensWithoutFindCode)}`);
console.log('\nCorrelation, not causation: turns differ in task size. Compare like-for-like modes before concluding.');
closeDb();
