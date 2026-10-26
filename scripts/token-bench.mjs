#!/usr/bin/env node
// Token & speed gate (Phase 1 P17, token-efficiency item 1).
//
// Starts its own extension/server.mjs on a free port with a temp DB, registers a
// throwaway user, and runs the fixed scenarios in schema/bench/scenarios.json.
// Every scenario sample opens NEW v2 chat(s) (POST /agent/v2/stream); each
// scenario is run --repeat times (default 3) and the MEDIAN is what gets compared.
//
// Per turn it records, from the turn's own usage_ledger rows (the main row and
// any `:internal` rows of the same turn) and its turn_composition row:
//   - billable tokens = input + output + 0.1 x cache read + 1.25 x cache write
//   - raw input / output / cache read / cache write
//   - hops (API calls in the turn), time to first token, total time
// and per scenario the context split of the last turn.
//
// Modes:
//   node scripts/token-bench.mjs --baseline   REAL run; writes the baseline
//   node scripts/token-bench.mjs              REAL run; compares with the baseline
//   node scripts/token-bench.mjs --fake       same pipeline, fake engine, no model calls
//
// A real run (default or --baseline) spends tokens. --fake spends none.
//
// Exit codes: 0 pass, 1 regression (or a real run whose tool scenarios made no
// tool calls), 2 no/incomparable baseline or an error.
//
// The child server inherits the caller's environment minus every LLMIDE_* variable
// (the bench sets only its own). HOME is kept on purpose: the Claude CLI finds its
// login through HOME (on macOS, the login keychain under ~/Library), so a temp HOME
// would break auth. Baselines are therefore machine- and account-dependent.

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
const WEIGHTS = { cacheRead: CACHE_READ_WEIGHT, cacheWrite: CACHE_WRITE_WEIGHT };
const DEFAULT_REPEAT = 3;
const FORBIDDEN_MODES = new Set(['auto', 'auto_read_only']);
const LEDGER_ENDPOINT = '/agent/v2/stream';

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

export function median(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

/**
 * Compares a results object with a baseline. Token gate: median billable tokens
 * up more than `tokenPct`. Time gate: median total time up more than `timePct`
 * AND by more than `timeFloorMs`; with `timeAdvisory` the time gate is reported
 * but never fails. A scenario in the baseline but missing now fails; a new one
 * is reported and does not fail.
 * @returns {{ rows: object[], failed: boolean }}
 */
export function compareResults(current, baseline, {
  tokenPct = 15, timePct = 30, timeFloorMs = 500, timeAdvisory = false,
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
    const slow = timeDelta > timePct && cur.totalMs - base.totalMs > timeFloorMs;
    const timeFail = slow && !timeAdvisory;
    let status = 'ok';
    if (tokFail || timeFail) status = 'REGRESSION';
    else if (slow) status = 'time-advisory';
    rows.push({
      id: base.id,
      baseTokens: base.billableTokens,
      curTokens: cur.billableTokens,
      tokDeltaPct: tokDelta,
      baseMs: base.totalMs,
      curMs: cur.totalMs,
      timeDeltaPct: timeDelta,
      status,
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

/**
 * Why a baseline cannot be compared with a run (empty when it can). A baseline
 * from another model, another fake/real mode, another scenario set version, or
 * other billing weights is a different measurement, not a regression.
 */
export function comparabilityProblems(current, baseline) {
  const problems = [];
  if (baseline.model !== current.model) problems.push(`model: baseline ${baseline.model} vs run ${current.model}`);
  if (Boolean(baseline.fake) !== Boolean(current.fake)) problems.push(`fake: baseline ${baseline.fake} vs run ${current.fake}`);
  if (baseline.scenariosVersion !== current.scenariosVersion) {
    problems.push(`scenariosVersion: baseline ${baseline.scenariosVersion} vs run ${current.scenariosVersion}`);
  }
  if (JSON.stringify(baseline.weights) !== JSON.stringify(current.weights)) {
    problems.push(`weights: baseline ${JSON.stringify(baseline.weights)} vs run ${JSON.stringify(current.weights)}`);
  }
  return problems;
}

/**
 * Scenarios that declare `expectTools` must show at least one turn with more
 * than one API call (a tool round trip), i.e. hops > turns. Returned as
 * warnings; the caller decides whether that fails.
 */
export function toolExpectationFailures(current) {
  return current.scenarios
    .filter((s) => s.expectTools && !(s.hops > s.turns))
    .map((s) => `${s.id}: expected a tool round trip (hops > turns), median hops = ${s.hops} over ${s.turns} turn(s)`);
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
  lines.push(`model: ${current.model}   repeat: ${current.repeat}   ${current.fake ? '[FAKE ENGINE - synthetic numbers]' : '[real engine]'}`);
  lines.push('(all values are medians over the repeats)');
  lines.push('scenario          turns  hops  billable   input   output  cacheRd  cacheWr   ttft ms   total ms');
  for (const s of current.scenarios) {
    lines.push([
      s.id.padEnd(17), String(s.turns).padStart(5), String(s.hops ?? '-').padStart(5),
      f(s.billableTokens).padStart(9), f(s.raw.input).padStart(7), f(s.raw.output).padStart(8),
      f(s.raw.cacheRead).padStart(8), f(s.raw.cacheWrite).padStart(8),
      f(s.ttftMs).padStart(9), f(s.totalMs).padStart(11),
    ].join(' '));
  }
  if (comparison) {
    lines.push('');
    lines.push('scenario          base tokens -> now (delta)              base ms -> now (delta)              status');
    for (const r of comparison.rows) {
      if (r.status === 'missing') { lines.push(`${r.id.padEnd(17)} MISSING from this run`); continue; }
      if (r.status === 'new') { lines.push(`${r.id.padEnd(17)} new (not in baseline)`); continue; }
      lines.push(`${r.id.padEnd(17)} ${f(r.baseTokens)} -> ${f(r.curTokens)} (${pct(r.tokDeltaPct)})`.padEnd(54)
        + `${f(r.baseMs)} -> ${f(r.curMs)} (${pct(r.timeDeltaPct)})`.padEnd(42) + r.status);
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
    if (FORBIDDEN_MODES.has(s.mode)) {
      throw new Error(`${file}: scenario ${s.id} uses mode "${s.mode}"; the bench pins explicit modes (the classifier would be part of the measurement)`);
    }
  }
  return { version: cfg.version, scenarios: cfg.scenarios };
}

/**
 * The usage_ledger rows of the given turns (request_id = turn id), for the main
 * v2 endpoint AND its `:internal` helper-model rows. Scoped to the user.
 */
export function ledgerRowsForTurns(db, userId, turnIds) {
  if (!turnIds.length) return [];
  const marks = turnIds.map(() => '?').join(', ');
  return db.prepare(
    `SELECT endpoint, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, request_id
       FROM usage_ledger
      WHERE user_id = ? AND request_id IN (${marks})
        AND (endpoint = '${LEDGER_ENDPOINT}' OR endpoint LIKE '${LEDGER_ENDPOINT}:%')`,
  ).all(userId, ...turnIds);
}

/**
 * The child server's environment: the caller's, minus every LLMIDE_* variable
 * (and NODE_ENV, NODE_TEST_CONTEXT), plus the bench's own settings. HOME is kept
 * so the Claude CLI login still resolves.
 */
export function buildChildEnv(base, { port, dbPath, jwtSecret, vaultKey, fake }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('LLMIDE_') || k === 'NODE_ENV' || k === 'NODE_TEST_CONTEXT') continue;
    env[k] = v;
  }
  Object.assign(env, {
    LLMIDE_PORT: String(port),
    LLMIDE_HOST: '127.0.0.1',
    LLMIDE_DB_PATH: dbPath,
    LLMIDE_JWT_SECRET: jwtSecret,
    LLMIDE_VAULT_KEY: vaultKey,
    LLMIDE_BACKUP_INTERVAL_HOURS: '0',
    LLMIDE_ENGINE_PREWARM: '0',
  });
  if (fake) env.LLMIDE_BENCH_FAKE = '1';
  return env;
}

// Deterministic seed files. The edit and explain scenarios read notes.txt (about
// 10 KB); the long-tool-results scenario reads three ~10 KB parts with different
// line counts, so "which has the most lines" has one answer.
const NOTE_SENTENCES = [
  'The token bench keeps every scenario fixed so that a change in cost is a change in the product.',
  'Each part of this workspace is plain prose, written only to give the agent something realistic to read.',
  'Alpha is the first word of the file and the target of the small edit scenario.',
  'Cache reads are cheap and cache writes cost more, so the shape of a chat matters as much as its length.',
  'Tool output is what fills the transcript; the bench measures how much of it each turn carries.',
];

function filler(lines, title) {
  const out = [`# ${title}`, ''];
  for (let i = 1; i <= lines; i += 1) {
    out.push(`${i}. ${NOTE_SENTENCES[i % NOTE_SENTENCES.length]} (${title}, line ${i})`);
  }
  return `${out.join('\n')}\n`;
}

export function seedWorkspace(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  // notes.txt starts with the word the edit scenario changes.
  const notes = `alpha\n${filler(150, 'notes').split('\n').slice(1).join('\n')}`;
  fs.writeFileSync(path.join(dir, 'notes.txt'), notes);
  fs.writeFileSync(path.join(dir, 'data', 'part-1.txt'), filler(140, 'Part one'));
  fs.writeFileSync(path.join(dir, 'data', 'part-2.txt'), filler(180, 'Part two'));
  fs.writeFileSync(path.join(dir, 'data', 'part-3.txt'), filler(120, 'Part three'));
}

// Temp dirs and servers of runs in progress, so a signal can clean them up.
const liveServers = new Set();
const liveDirs = new Set();

/** Stops every server this process started and removes its temp dirs. */
export async function cleanupAll() {
  await Promise.all([...liveServers].map((s) => s.stop()));
  for (const d of liveDirs) fs.rmSync(d, { recursive: true, force: true });
  liveDirs.clear();
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const KILL_AFTER_MS = 5000;

async function startServer({ fake, dir, port }) {
  const env = buildChildEnv(process.env, {
    port,
    dbPath: path.join(dir, 'bench.db'),
    jwtSecret: randomBytes(36).toString('hex'),
    vaultKey: randomBytes(36).toString('hex'),
    fake,
  });
  const args = ['server.mjs', ...(fake ? ['--bench-fake'] : [])];
  const child = spawn(process.execPath, args, { cwd: EXT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const server = {
    base,
    child,
    /** The server's recent stdout/stderr, for diagnosing a failed run. */
    tail(n = 3000) { return output.slice(-n); },
    stop() {
      return new Promise((resolve) => {
        liveServers.delete(server);
        if (child.exitCode != null) { resolve(); return; }
        const killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
        child.once('exit', () => { clearTimeout(killTimer); resolve(); });
        child.kill('SIGTERM');
      });
    },
  };
  liveServers.add(server);
  return server;
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
const MAX_RATE_LIMIT_RETRIES = 30;
// A turn that runs longer than this is stuck (e.g. waiting on an approval
// nobody answers), not slow: fail it with a clear message instead of hanging
// until the stream or the access token dies.
const TURN_TIMEOUT_MS = 240_000;

/**
 * POST the turn, waiting out the server's per-user turn limiter (429) and
 * retrying: the limiter answers before the turn starts, so nothing was run or
 * metered. Only the successful attempt is timed.
 */
async function openTurnStream(body, base, token) {
  for (let attempt = 0; ; attempt += 1) {
    const started = performance.now();
    const res = await fetch(`${base}/agent/v2/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await res.text();
      await new Promise((r) => setTimeout(r, (retryAfter + 0.2) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`stream HTTP ${res.status}: ${await res.text()}`);
    return { res, started };
  }
}

async function streamTurn({ base, token, chatSessionId, workspaceRoot, mode, model, message }) {
  // accept-edits: the bench workspace is a throwaway temp dir, and with the
  // default ('ask') an edit waits on an approval prompt the bench never answers.
  const body = JSON.stringify({
    message, mode, model, provider: 'anthropic', permissionMode: 'accept-edits',
    agentContext: { chatSessionId, workspaceRoot },
  });
  // `started` is the successful attempt's request start, so waits for the
  // limiter are not billed as turn time.
  const { res, started } = await openTurnStream(body, base, token);
  let ttftMs = null;
  let error = null;
  let sdkSessionId = null;
  let declined = 0;
  let buf = '';
  const decoder = new TextDecoder();
  try {
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
        if (ev.type === 'init' && ev.sessionId) sdkSessionId = ev.sessionId;
        // Nobody answers a question or an approval in a bench run: decline it
        // at once (as a user dismissing it would) so the turn carries on
        // instead of parking until the decision times out.
        if (ev.type === 'approval_request' && ev.requestId) {
          declined += 1;
          await declineDecision({ base, token, requestId: ev.requestId, sdkSessionId });
        }
      }
    }
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new Error(`turn did not finish within ${TURN_TIMEOUT_MS / 1000} s (stuck, e.g. on an approval): ${message.slice(0, 60)}`);
    }
    throw err;
  }
  return { ttftMs, totalMs: performance.now() - started, error, declined };
}

async function declineDecision({ base, token, requestId, sdkSessionId }) {
  const r = await fetch(`${base}/agent/v2/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId, sdkSessionId, action: 'deny' }),
  });
  if (!r.ok) throw new Error(`decline decision HTTP ${r.status}: ${await r.text()}`);
}

async function fetchComposition(ctx) {
  const r = await fetch(`${ctx.base}/kb/usage/turn-composition?limit=200`, {
    headers: { Authorization: `Bearer ${ctx.token}` },
  });
  if (!r.ok) throw new Error(`turn-composition HTTP ${r.status}`);
  return (await r.json()).turns || [];
}

/** One turn's metering: its turn-composition row (for the turn id) and its ledger rows. */
async function meterTurn(ctx, seenTurnIds) {
  const fresh = (await fetchComposition(ctx)).filter((t) => !seenTurnIds.has(t.turnId));
  if (fresh.length !== 1) {
    throw new Error(`expected exactly one new turn-composition row for the turn, found ${fresh.length}`);
  }
  const comp = fresh[0];
  seenTurnIds.add(comp.turnId);
  const rows = ledgerRowsForTurns(ctx.ledger, ctx.userId, [comp.turnId]);
  if (rows.length === 0) throw new Error(`turn ${comp.turnId}: no usage_ledger rows`);
  const raw = rows.reduce((a, r) => ({
    input: a.input + (r.input_tokens || 0),
    output: a.output + (r.output_tokens || 0),
    cacheRead: a.cacheRead + (r.cache_read_tokens || 0),
    cacheWrite: a.cacheWrite + (r.cache_creation_tokens || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return { comp, raw };
}

/** One sample of one scenario: a fresh workspace and a fresh chat, every turn metered. */
async function runSample({ scenario, ctx }) {
  seedWorkspace(ctx.workspaceRoot);
  const chatSessionId = randomUUID();
  const turns = [];
  for (const message of scenario.turns) {
    const t = await streamTurn({
      base: ctx.base, token: ctx.token, chatSessionId, workspaceRoot: ctx.workspaceRoot,
      mode: scenario.mode, model: ctx.model, message,
    });
    if (t.error) throw new Error(`scenario ${scenario.id}: ${t.error}`);
    const { comp, raw } = await meterTurn(ctx, ctx.seenTurnIds);
    turns.push({
      hops: Number(comp.apiCalls) || 0,
      raw,
      billable: billableTokens(raw),
      ttftMs: t.ttftMs,
      totalMs: t.totalMs,
      declinedDecisions: t.declined,
      split: {
        firstCallPromptTokens: comp.firstCallPromptTokens ?? null,
        systemPromptTokens: comp.systemPromptTokens ?? null,
        llmideToolTokens: comp.llmideToolTokens ?? null,
        skillsAppendTokens: comp.skillsAppendTokens ?? null,
        contextFenceTokens: comp.contextFenceTokens ?? null,
        memoryFenceTokens: comp.memoryFenceTokens ?? null,
        toolResultTokens: comp.toolResultTokens ?? null,
        sdkContextTotalTokens: comp.sdkContextTotalTokens ?? null,
      },
    });
  }
  const raw = {
    input: turns.reduce((n, t) => n + t.raw.input, 0),
    output: turns.reduce((n, t) => n + t.raw.output, 0),
    cacheRead: turns.reduce((n, t) => n + t.raw.cacheRead, 0),
    cacheWrite: turns.reduce((n, t) => n + t.raw.cacheWrite, 0),
  };
  const ttfts = turns.map((t) => t.ttftMs).filter((v) => v != null);
  return {
    billableTokens: billableTokens(raw),
    totalMs: Math.round(turns.reduce((n, t) => n + t.totalMs, 0)),
    ttftMs: ttfts.length ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null,
    hops: turns.reduce((n, t) => n + t.hops, 0),
    raw,
    turns,
    contextSplit: turns.length ? turns[turns.length - 1].split : null,
  };
}

/** Aggregates the repeats of one scenario: medians, and the per-turn detail of the median sample. */
function aggregate(scenario, samples) {
  const median3 = (f) => median(samples.map(f));
  const byBillable = [...samples].sort((a, b) => a.billableTokens - b.billableTokens);
  const medianSample = byBillable[Math.floor((byBillable.length - 1) / 2)];
  return {
    id: scenario.id,
    mode: scenario.mode,
    expectTools: scenario.expectTools === true,
    turns: scenario.turns.length,
    n: samples.length,
    billableTokens: median3((s) => s.billableTokens),
    totalMs: median3((s) => s.totalMs),
    ttftMs: median3((s) => s.ttftMs),
    hops: median3((s) => s.hops),
    raw: {
      input: median3((s) => s.raw.input),
      output: median3((s) => s.raw.output),
      cacheRead: median3((s) => s.raw.cacheRead),
      cacheWrite: median3((s) => s.raw.cacheWrite),
    },
    billableSamples: samples.map((s) => s.billableTokens),
    perTurn: medianSample.turns.map((t) => ({
      hops: t.hops, billable: t.billable, input: t.raw.input, output: t.raw.output,
      cacheRead: t.raw.cacheRead, cacheWrite: t.raw.cacheWrite,
    })),
    contextSplit: medianSample.contextSplit,
  };
}

/**
 * Runs every scenario against a fresh temp-DB server, each `repeat` times.
 * @returns {Promise<object>} results (schema token-bench/2)
 */
export async function runBench({
  fake = false, model, scenarios, scenariosVersion = 1, repeat = DEFAULT_REPEAT, log = () => {},
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-token-bench-'));
  liveDirs.add(dir);
  const workspaceRoot = path.join(dir, 'workspace');
  const port = await freePort();
  const server = await startServer({ fake, dir, port });
  try {
    const { userId, token } = await registerAndLogin(server.base);
    const { DatabaseSync } = await import('node:sqlite');
    const ledger = new DatabaseSync(path.join(dir, 'bench.db'), { readOnly: true });
    try {
      const ctx = {
        base: server.base, token, userId, ledger, workspaceRoot, model, seenTurnIds: new Set(),
      };
      const results = [];
      for (const scenario of scenarios) {
        const samples = [];
        for (let i = 0; i < repeat; i += 1) {
          log(`running ${scenario.id} (${i + 1}/${repeat}) ...`);
          samples.push(await runSample({ scenario, ctx }));
        }
        results.push(aggregate(scenario, samples));
      }
      return {
        schema: 'token-bench/2',
        generatedAt: new Date().toISOString(),
        fake,
        model,
        repeat,
        scenariosVersion,
        weights: WEIGHTS,
        scenarios: results,
      };
    } finally {
      ledger.close();
    }
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    liveDirs.delete(dir);
  }
}

function parseArgs(argv) {
  const opts = {
    fake: false, baseline: false, model: null, baselineFile: DEFAULT_BASELINE, out: null,
    scenarios: DEFAULT_SCENARIOS, repeat: DEFAULT_REPEAT,
    tokenPct: 15, timePct: 30, timeFloorMs: 500, timeAdvisory: false,
  };
  const need = (i, flag) => {
    if (argv[i + 1] == null || argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--fake') opts.fake = true;
    else if (a === '--baseline') opts.baseline = true;
    else if (a === '--time-advisory') opts.timeAdvisory = true;
    else if (a === '--model') { opts.model = need(i, a); i += 1; }
    else if (a === '--baseline-file') { opts.baselineFile = need(i, a); i += 1; }
    else if (a === '--out') { opts.out = need(i, a); i += 1; }
    else if (a === '--scenarios') { opts.scenarios = need(i, a); i += 1; }
    else if (a === '--repeat') { opts.repeat = Number(need(i, a)); i += 1; }
    else if (a === '--threshold-tokens') { opts.tokenPct = Number(need(i, a)); i += 1; }
    else if (a === '--threshold-time') { opts.timePct = Number(need(i, a)); i += 1; }
    else if (a === '--time-floor-ms') { opts.timeFloorMs = Number(need(i, a)); i += 1; }
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1) throw new Error('--repeat must be a positive integer');
  return opts;
}

function installSignalCleanup() {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(sig, () => {
      cleanupAll().finally(() => process.exit(code));
    });
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.baseline && opts.fake) {
    console.error('refusing to write a baseline from --fake: its numbers are synthetic');
    return 2;
  }
  installSignalCleanup();
  const model = opts.model || defaultBenchModel();
  const { version, scenarios } = loadScenarios(opts.scenarios);
  if (!opts.fake) {
    console.error(`token bench: REAL run on ${model} — spends tokens (${scenarios.length} scenarios x ${opts.repeat} repeats).`);
  }
  const current = await runBench({
    fake: opts.fake, model, scenarios, scenariosVersion: version, repeat: opts.repeat, log: (m) => console.error(m),
  });

  // A private directory, not a predictable name in the shared temp dir.
  const outFile = opts.out || path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'token-bench-')), 'results.json');
  fs.writeFileSync(outFile, `${JSON.stringify(current, null, 2)}\n`);

  if (opts.baseline) {
    fs.writeFileSync(opts.baselineFile, `${JSON.stringify(current, null, 2)}\n`);
    console.log(formatTable(current));
    console.log(`\nbaseline written: ${opts.baselineFile}`);
    return 0;
  }
  const warnings = toolExpectationFailures(current);
  const toolFailures = opts.fake ? [] : warnings;
  for (const w of warnings) console.log(`${opts.fake ? 'WARN' : 'FAIL'} (tool expectation): ${w}`);

  if (!fs.existsSync(opts.baselineFile)) {
    console.log(formatTable(current));
    console.log(`\nno baseline at ${opts.baselineFile} — run with --baseline first. results: ${outFile}`);
    return 2;
  }
  const baseline = JSON.parse(fs.readFileSync(opts.baselineFile, 'utf8'));
  const problems = comparabilityProblems(current, baseline);
  if (problems.length) {
    console.error(`baseline ${opts.baselineFile} is not comparable with this run:\n  ${problems.join('\n  ')}`);
    return 2;
  }
  const comparison = compareResults(current, baseline, {
    tokenPct: opts.tokenPct, timePct: opts.timePct, timeFloorMs: opts.timeFloorMs, timeAdvisory: opts.timeAdvisory,
  });
  console.log(formatTable(current, comparison));
  console.log(`\nresults: ${outFile}`);
  if (comparison.failed || toolFailures.length) {
    if (comparison.failed) {
      console.log(`FAILED: regression > ${opts.tokenPct}% tokens or > ${opts.timePct}% time (and > ${opts.timeFloorMs} ms)`);
    }
    if (toolFailures.length) console.log('FAILED: tool scenarios made no tool calls');
    return 1;
  }
  console.log('PASS: no scenario regressed');
  return 0;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).then(
    async (code) => { await cleanupAll(); process.exitCode = code; },
    async (err) => {
      console.error(err?.stack || err);
      for (const s of liveServers) {
        const exited = s.child.exitCode != null ? ` (server exited with ${s.child.exitCode})` : '';
        console.error(`--- bench server output${exited} ---\n${s.tail()}`);
      }
      await cleanupAll();
      process.exitCode = 2;
    },
  );
}
