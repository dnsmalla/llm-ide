#!/usr/bin/env node
// Token & speed gate (Phase 1 P17, token-efficiency item 1).
//
// Starts its own extension/server.mjs on a free port with a temp DB, registers a
// throwaway user, and runs the fixed scenarios in schema/bench/scenarios.json —
// each in a NEW v2 chat (POST /agent/v2/stream). Per scenario it records:
//   - billable tokens  = input + output + 0.1 x cache read + 1.25 x cache write
//   - raw input / output / cache read / cache write (usage_ledger rows)
//   - turns (user messages), hops (sum of apiCalls from turn_composition)
//   - time to first token (client side, first `delta` event) and total time
//   - the context split of the scenario's last turn (GET /kb/usage/turn-composition)
//
// Modes:
//   node scripts/token-bench.mjs --baseline          run the real model, write the baseline
//   node scripts/token-bench.mjs                     run, compare with the baseline, exit 1 on regression
//   node scripts/token-bench.mjs --fake              same pipeline, fake engine (no model calls)
//
// Costs real money in the default and --baseline modes (one short turn per
// scenario, 7 turns in all, on the cheapest model). --fake makes no model call.
//
// Usage flags: --model <id> --baseline-file <path> --out <path> --scenarios <path>
//   --threshold-tokens <pct> (15) --threshold-time <pct> (15) --time-floor-ms <ms> (500)

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const BENCH_DIR = path.join(ROOT, 'schema', 'bench');
const DEFAULT_SCENARIOS = path.join(BENCH_DIR, 'scenarios.json');
const DEFAULT_BASELINE = path.join(BENCH_DIR, 'token-baseline.json');
const MODELS_FILE = path.join(ROOT, 'schema', 'models', 'anthropic-models.json');

const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

/** The cheapest capable model: the picker entry flagged `fast` in anthropic-models.json. */
export function defaultBenchModel(modelsFile = MODELS_FILE) {
  const cfg = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  const fast = cfg.models.find((m) => m.fast);
  if (!fast?.id) throw new Error(`${modelsFile}: no model with "fast": true`);
  return fast.id;
}

/** Billable-weighted tokens for one raw usage record. */
export function billableTokens({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return Math.round(input + output + cacheRead * CACHE_READ_WEIGHT + cacheWrite * CACHE_WRITE_WEIGHT);
}

/**
 * Compares a results object with a baseline. A scenario fails when its billable
 * tokens rise more than `tokenPct`, or its total time rises more than `timePct`
 * AND by more than `timeFloorMs` (sub-second jitter on fast turns is not a
 * regression). A scenario present in the baseline but missing now fails.
 * @returns {{ rows: object[], failed: boolean }}
 */
export function compareResults(current, baseline, {
  tokenPct = 15, timePct = 15, timeFloorMs = 500,
} = {}) {
  const curById = new Map(current.scenarios.map((s) => [s.id, s]));
  const rows = [];
  for (const base of baseline.scenarios) {
    const cur = curById.get(base.id);
    if (!cur) {
      rows.push({ id: base.id, status: 'missing', failed: true });
      continue;
    }
    const tokDelta = pctChange(base.billableTokens, cur.billableTokens);
    const timeDelta = pctChange(base.totalMs, cur.totalMs);
    const tokFail = tokDelta > tokenPct;
    const timeFail = timeDelta > timePct && cur.totalMs - base.totalMs > timeFloorMs;
    rows.push({
      id: base.id,
      baseTokens: base.billableTokens,
      curTokens: cur.billableTokens,
      tokDeltaPct: tokDelta,
      baseMs: base.totalMs,
      curMs: cur.totalMs,
      timeDeltaPct: timeDelta,
      status: tokFail || timeFail ? 'REGRESSION' : 'ok',
      failed: tokFail || timeFail,
    });
  }
  for (const cur of current.scenarios) {
    if (!baseline.scenarios.some((b) => b.id === cur.id)) {
      rows.push({ id: cur.id, curTokens: cur.billableTokens, curMs: cur.totalMs, status: 'new', failed: false });
    }
  }
  return { rows, failed: rows.some((r) => r.failed) };
}

function pctChange(base, cur) {
  if (!base) return cur > 0 ? Infinity : 0;
  return ((cur - base) / base) * 100;
}

/** Renders the current results (and the comparison, when there is one) as text. */
export function formatTable(current, comparison = null) {
  const f = (n) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'));
  const pct = (n) => (n == null || !Number.isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
  const lines = [];
  lines.push(`model: ${current.model}   ${current.fake ? '[FAKE ENGINE - synthetic numbers]' : '[real engine]'}`);
  lines.push('scenario        turns  hops  billable   input   output  cacheRd  cacheWr   ttft ms   total ms');
  for (const s of current.scenarios) {
    lines.push([
      s.id.padEnd(16), String(s.turns).padStart(5), String(s.hops ?? '-').padStart(5),
      f(s.billableTokens).padStart(9), f(s.raw.input).padStart(7), f(s.raw.output).padStart(8),
      f(s.raw.cacheRead).padStart(8), f(s.raw.cacheWrite).padStart(8),
      f(s.ttftMs).padStart(9), f(s.totalMs).padStart(11),
    ].join(' '));
  }
  if (comparison) {
    lines.push('');
    lines.push('scenario        base tokens -> now (delta)            base ms -> now (delta)            status');
    for (const r of comparison.rows) {
      if (r.status === 'missing') { lines.push(`${r.id.padEnd(16)} MISSING from this run`); continue; }
      if (r.status === 'new') { lines.push(`${r.id.padEnd(16)} new (not in baseline)`); continue; }
      lines.push(`${r.id.padEnd(16)} ${f(r.baseTokens)} -> ${f(r.curTokens)} (${pct(r.tokDeltaPct)})`.padEnd(48)
        + `${f(r.baseMs)} -> ${f(r.curMs)} (${pct(r.timeDeltaPct)})`.padEnd(40) + r.status);
    }
  }
  return lines.join('\n');
}

export function loadScenarios(file = DEFAULT_SCENARIOS) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cfg.scenarios) || cfg.scenarios.length === 0) throw new Error(`${file}: no scenarios`);
  for (const s of cfg.scenarios) {
    if (!s.id || !s.mode || !Array.isArray(s.turns) || s.turns.length === 0) {
      throw new Error(`${file}: scenario needs id, mode and turns: ${JSON.stringify(s)}`);
    }
  }
  return cfg.scenarios;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer({ fake, dir, port }) {
  const env = {
    ...process.env,
    LLMIDE_PORT: String(port),
    LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: path.join(dir, 'bench.db'),
    LLMIDE_JWT_SECRET: randomBytes(36).toString('hex'),
    LLMIDE_VAULT_KEY: randomBytes(36).toString('hex'),
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    LLMIDE_ENGINE_PREWARM: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_ENV;
  if (fake) env.LLMIDE_BENCH_FAKE = '1'; else delete env.LLMIDE_BENCH_FAKE;
  const child = spawn(process.execPath, ['server.mjs'], { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`server exited early: ${output.slice(-1500)}`);
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill('SIGTERM'); throw new Error(`server did not answer /health: ${output.slice(-1500)}`); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const stop = async () => {
    child.kill('SIGTERM');
    if (child.exitCode == null) await new Promise((r) => child.once('exit', r));
  };
  return { base, stop, child };
}

async function registerAndLogin(base) {
  const email = `bench+${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const reg = await fetch(`${base}/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName: 'token bench' }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
  const session = await login.json();
  return { userId: session.user.id, token: session.accessToken };
}

/**
 * One chat turn: POST /agent/v2/stream, read the SSE stream to its end.
 * @returns {Promise<{ ttftMs: number|null, totalMs: number, error: string|null }>}
 */
async function streamTurn({ base, token, chatSessionId, workspaceRoot, mode, model, message }) {
  const started = performance.now();
  const res = await fetch(`${base}/agent/v2/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, mode, model, provider: 'anthropic', agentContext: { chatSessionId, workspaceRoot } }),
  });
  if (!res.ok) throw new Error(`stream HTTP ${res.status}: ${await res.text()}`);
  let ttftMs = null;
  let error = null;
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'delta' && ttftMs === null) ttftMs = performance.now() - started;
      if (ev.type === 'error') error = `${ev.code}: ${ev.message}`;
    }
  }
  return { ttftMs, totalMs: performance.now() - started, error };
}

/** Read-only view of the server's temp DB (WAL: readers never block the writer). */
async function openLedger(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

function maxLedgerId(db, userId) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM usage_ledger WHERE user_id = ?').get(userId).m;
}

function ledgerRowsSince(db, userId, afterId) {
  return db.prepare(
    `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, request_id
       FROM usage_ledger WHERE user_id = ? AND id > ? AND endpoint = '/agent/v2/stream'`,
  ).all(userId, afterId);
}

async function runScenario({ scenario, ctx }) {
  const chatSessionId = randomUUID();
  const turnStats = [];
  const afterId = maxLedgerId(ctx.ledger, ctx.userId);
  for (const message of scenario.turns) {
    const t = await streamTurn({
      base: ctx.base, token: ctx.token, chatSessionId, workspaceRoot: ctx.workspaceRoot,
      mode: scenario.mode, model: ctx.model, message,
    });
    if (t.error) throw new Error(`scenario ${scenario.id}: ${t.error}`);
    turnStats.push(t);
  }
  const rows = ledgerRowsSince(ctx.ledger, ctx.userId, afterId);
  if (rows.length === 0) throw new Error(`scenario ${scenario.id}: no usage_ledger rows were written`);
  const raw = rows.reduce((a, r) => ({
    input: a.input + (r.input_tokens || 0),
    output: a.output + (r.output_tokens || 0),
    cacheRead: a.cacheRead + (r.cache_read_tokens || 0),
    cacheWrite: a.cacheWrite + (r.cache_creation_tokens || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  const turnIds = new Set(rows.map((r) => r.request_id).filter(Boolean));
  const comp = await fetch(`${ctx.base}/kb/usage/turn-composition?limit=200`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
  }).then((r) => r.json());
  const ours = (comp.turns || []).filter((t) => turnIds.has(t.turnId));
  const hops = ours.length ? ours.reduce((n, t) => n + (Number(t.apiCalls) || 0), 0) : null;
  const last = ours.length ? ours.reduce((a, b) => (String(a.createdAt) > String(b.createdAt) ? a : b)) : null;
  const split = last ? {
    firstCallPromptTokens: last.firstCallPromptTokens ?? null,
    systemPromptTokens: last.systemPromptTokens ?? null,
    llmideToolTokens: last.llmideToolTokens ?? null,
    skillsAppendTokens: last.skillsAppendTokens ?? null,
    contextFenceTokens: last.contextFenceTokens ?? null,
    memoryFenceTokens: last.memoryFenceTokens ?? null,
    toolResultTokens: last.toolResultTokens ?? null,
    sdkContextTotalTokens: last.sdkContextTotalTokens ?? null,
  } : null;

  const ttfts = turnStats.map((t) => t.ttftMs).filter((v) => v != null);
  return {
    id: scenario.id,
    mode: scenario.mode,
    turns: scenario.turns.length,
    hops,
    raw,
    billableTokens: billableTokens(raw),
    ttftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
    totalMs: Math.round(turnStats.reduce((a, t) => a + t.totalMs, 0)),
    contextSplit: split,
  };
}

/**
 * Runs every scenario against a fresh temp-DB server.
 * @returns {Promise<object>} results (see writeJSON for the file shape)
 */
export async function runBench({ fake = false, model, scenarios, log = () => {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-token-bench-'));
  const workspaceRoot = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, 'notes.txt'), 'alpha\nbeta\n');
  const port = await freePort();
  const server = await startServer({ fake, dir, port });
  try {
    const { userId, token } = await registerAndLogin(server.base);
    const ledger = await openLedger(path.join(dir, 'bench.db'));
    try {
      const results = [];
      for (const scenario of scenarios) {
        log(`running ${scenario.id} ...`);
        results.push(await runScenario({
          scenario, ctx: { base: server.base, token, userId, ledger, workspaceRoot, model },
        }));
      }
      return {
        schema: 'token-bench/1',
        generatedAt: new Date().toISOString(),
        fake,
        model,
        weights: { cacheRead: CACHE_READ_WEIGHT, cacheWrite: CACHE_WRITE_WEIGHT },
        scenarios: results,
      };
    } finally {
      ledger.close();
    }
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = {
    fake: false, baseline: false, model: null, baselineFile: DEFAULT_BASELINE, out: null,
    scenarios: DEFAULT_SCENARIOS, tokenPct: 15, timePct: 15, timeFloorMs: 500,
  };
  const need = (i, flag) => {
    if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fake') opts.fake = true;
    else if (a === '--baseline') opts.baseline = true;
    else if (a === '--model') { opts.model = need(i, a); i += 1; }
    else if (a === '--baseline-file') { opts.baselineFile = need(i, a); i += 1; }
    else if (a === '--out') { opts.out = need(i, a); i += 1; }
    else if (a === '--scenarios') { opts.scenarios = need(i, a); i += 1; }
    else if (a === '--threshold-tokens') { opts.tokenPct = Number(need(i, a)); i += 1; }
    else if (a === '--threshold-time') { opts.timePct = Number(need(i, a)); i += 1; }
    else if (a === '--time-floor-ms') { opts.timeFloorMs = Number(need(i, a)); i += 1; }
    else throw new Error(`unknown flag: ${a}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.baseline && opts.fake) {
    console.error('refusing to write a baseline from --fake: its numbers are synthetic');
    return 2;
  }
  const model = opts.model || defaultBenchModel();
  const scenarios = loadScenarios(opts.scenarios);
  if (!opts.fake) {
    console.error(`token bench: REAL run on ${model} — this spends tokens (${scenarios.length} scenarios).`);
  }
  const current = await runBench({ fake: opts.fake, model, scenarios, log: (m) => console.error(m) });

  const outFile = opts.out || path.join(os.tmpdir(), `token-bench-${Date.now()}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(current, null, 2)}\n`);

  if (opts.baseline) {
    fs.writeFileSync(opts.baselineFile, `${JSON.stringify(current, null, 2)}\n`);
    console.log(formatTable(current));
    console.log(`\nbaseline written: ${opts.baselineFile}`);
    return 0;
  }
  if (!fs.existsSync(opts.baselineFile)) {
    console.log(formatTable(current));
    console.log(`\nno baseline at ${opts.baselineFile} — run with --baseline first. results: ${outFile}`);
    return 2;
  }
  const baseline = JSON.parse(fs.readFileSync(opts.baselineFile, 'utf8'));
  const comparison = compareResults(current, baseline, {
    tokenPct: opts.tokenPct, timePct: opts.timePct, timeFloorMs: opts.timeFloorMs,
  });
  console.log(formatTable(current, comparison));
  console.log(`\nresults: ${outFile}`);
  if (comparison.failed) {
    console.log(`FAILED: regression > ${opts.tokenPct}% tokens or > ${opts.timePct}% time (and > ${opts.timeFloorMs} ms)`);
    return 1;
  }
  console.log('PASS: no scenario regressed');
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(err?.stack || err); process.exitCode = 2; },
  );
}
