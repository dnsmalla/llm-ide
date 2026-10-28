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
// Turn history lives in agent.db (Stage 1b); live usage_ledger stays in the main DB.
const agentDbPath = process.env.LLMIDE_AGENT_DB_PATH || path.join(path.dirname(dbPath), 'agent.db');

const daysArg = process.argv.indexOf('--days');
const rawDays = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;
// Same clamp the summary applies, so the header states the window actually used.
const days = Math.max(1, Math.min(365, Math.trunc(rawDays)));

const { summarizeToolEventsOn } = await import('../kb/tool-events-summary.mjs');

let db;
let agentDb;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`Failed to open DB: ${err.message}`);
  process.exit(1);
}
try {
  agentDb = new Database(agentDbPath, { readonly: true, fileMustExist: true });
} catch {
  console.log(`No agent history yet: ${agentDbPath} does not exist. Start the backend on this code, then re-run.`);
  db.close();
  process.exit(0);
}

let s;
let legacy;
let loop;
try {
  s = summarizeToolEventsOn(agentDb, null, { days, ledgerDb: db });
  legacy = summarizeToolEventsOn(agentDb, null, { days, engine: 'legacy', ledgerDb: db });
  loop = summarizeToolEventsOn(agentDb, null, { days, engine: 'loop', ledgerDb: db });
} catch (err) {
  if (/no such table: (agent_tool_events|usage_ledger)/.test(err.message)) {
    console.log('No tool accounting yet: the backend has not run migration 0035. Restart the backend on this code, then re-run.');
    db.close();
    agentDb.close();
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
// Chat prompt composition (migration 0040): what a turn's FIRST API call was
// made of, by mode. The composition rows are in agent.db and the ledger in the
// main DB, so the join is done here: two handles, no ATTACH.
try {
  const turns = agentDb.prepare(
    `SELECT turn_id, mode, resumed, system_prompt_kind AS kind, api_calls, first_call_prompt_tokens AS firstCall,
            first_call_cache_read_tokens AS firstRead, system_chars AS sys, prompt_chars AS prompt,
            attachment_chars AS att, tools, mcp_tools AS mcp, skills, agents, mcp_servers AS servers
       FROM turn_composition c
      WHERE c.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
        AND c.first_call_prompt_tokens IS NOT NULL`,
  ).all(`-${days} days`);
  // Both averages over the SAME turns: only turns with at least one ledger row.
  const ledger = new Map();
  for (let i = 0; i < turns.length; i += 500) {
    const ids = turns.slice(i, i + 500).map((t) => t.turn_id);
    const marks = ids.map(() => '?').join(', ');
    for (const r of db.prepare(
      `SELECT request_id, SUM(COALESCE(input_tokens,0) + COALESCE(cache_read_tokens,0) + COALESCE(cache_creation_tokens,0)) AS tok
         FROM usage_ledger WHERE request_id IN (${marks}) GROUP BY request_id`,
    ).all(...ids)) ledger.set(r.request_id, r.tok);
  }
  const withLedger = turns.filter((t) => ledger.has(t.turn_id));
  const avg = (xs) => {
    const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number);
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const groups = new Map();
  for (const t of withLedger) {
    const key = `${t.mode}\u0000${t.resumed}\u0000${t.kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const rows = [...groups.values()].map((g) => ({
    mode: g[0].mode, resumed: g[0].resumed, kind: g[0].kind, turns: g.length,
    calls: avg(g.map((t) => t.api_calls)) ?? null,
    ledger: avg(g.map((t) => ledger.get(t.turn_id))),
    firstCall: avg(g.map((t) => t.firstCall)),
    firstRead: avg(g.map((t) => t.firstRead)),
    sys: avg(g.map((t) => t.sys)), prompt: avg(g.map((t) => t.prompt)),
    att: avg(g.map((t) => t.att)), tools: avg(g.map((t) => t.tools)),
    mcp: avg(g.map((t) => t.mcp)), skills: avg(g.map((t) => t.skills)), agents: avg(g.map((t) => t.agents)),
    servers: [...new Set(g.map((t) => t.servers).filter(Boolean))].join(',') || null,
  })).sort((a, b) => b.turns - a.turns);
  console.log('\nChat prompt composition (first API call of each turn; chars, not tokens, except firstCall/firstRead):');
  if (!rows.length) console.log('  no data yet');
  for (const r of rows) {
    console.log(`  ${String(r.mode).padEnd(10)} ${r.resumed ? 'resumed' : 'fresh  '} ${String(r.kind).padEnd(7)} ${String(r.turns).padStart(4)} turns · ${r.calls} API calls · ledger ${r.ledger} tok vs firstCall ${r.firstCall} (read ${r.firstRead})`);
    console.log(`      system ${r.sys} · prompt ${r.prompt} · attachments ${r.att} chars · tools ${r.tools} (mcp ${r.mcp}: ${r.servers || '-'}) · skills ${r.skills} · agents ${r.agents}`);
  }
} catch (err) {
  if (!/no such table: turn_composition/.test(err.message)) throw err;
  console.log('\nChat prompt composition: not recorded yet (restart the backend on this code to run migration 0040).');
}
console.log('\nCorrelation, not causation: turns differ in task size. Compare like-for-like modes before concluding.');
db.close();
agentDb.close();
