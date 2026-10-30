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
//   node scripts/token-bench.mjs --env KEY=VAL ...   repeatable; sets KEY in the child server
//        (only LLMIDE_* / CLAUDE_CODE_* names; bench-owned and isolation names are refused)
//   node scripts/token-bench.mjs --compare a.json b.json   no run: paired, spread-aware
//        comparison of two results files (exit 1 on a gate regression)
//
// The child server inherits the caller's environment minus every LLMIDE_* variable
// (the bench sets only its own, plus any --env). HOME is kept on purpose: the Claude CLI finds its
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
const FIXTURE_MCP = path.join(ROOT, 'scripts', 'bench-fixtures', 'fake-mcp-server.mjs');
// Real runs wait this long after a sample for fire-and-forget helper calls
// (memory extraction) to reach the ledger before they are counted.
const HELPER_SETTLE_MS = 2500;

// --env: only these name families reach the child server. LLMIDE_* are server
// switches; CLAUDE_CODE_* pass through the server to the SDK subprocess (the
// SDK subprocess env drops LLMIDE_*, see sdk/subprocess-env.mjs).
const ENV_NAME_RE = /^(LLMIDE_|CLAUDE_CODE_)[A-Z0-9_]+$/;
// Names the bench owns or that would break its isolation (real DB, real data
// dir, real log, remote bind, the fake-engine switch).
const RESERVED_ENV = new Set([
  'LLMIDE_PORT', 'LLMIDE_HOST', 'LLMIDE_DB_PATH', 'LLMIDE_AGENT_DB_PATH', 'LLMIDE_JWT_SECRET',
  'LLMIDE_VAULT_KEY', 'LLMIDE_BACKUP_INTERVAL_HOURS', 'LLMIDE_BACKUP_DIR', 'LLMIDE_ENGINE_PREWARM',
  'LLMIDE_BENCH_FAKE', 'LLMIDE_DATA_DIR', 'LLMIDE_LOG_FILE', 'LLMIDE_PLUGIN_DIR',
  'LLMIDE_ALLOW_REMOTE', 'LLMIDE_ALLOW_REMOTE_REGISTRATION',
]);

/**
 * Parses one `--env KEY=VAL`. The value may contain '=' and may be empty.
 * @returns {[string, string]}
 */
export function parseEnvAssignment(text) {
  const eq = String(text).indexOf('=');
  if (eq <= 0) throw new Error(`--env needs KEY=VAL, got "${text}"`);
  const key = text.slice(0, eq);
  const value = text.slice(eq + 1);
  if (!ENV_NAME_RE.test(key)) {
    throw new Error(`--env ${key}: only LLMIDE_* and CLAUDE_CODE_* names (upper case) are allowed through to the child server`);
  }
  if (RESERVED_ENV.has(key)) throw new Error(`--env ${key}: owned by the bench (isolation or fake switch); refused`);
  return [key, value];
}

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
  // A newer scenario set may declare the older versions it still contains
  // unchanged (`compatibleWith` in scenarios.json); the baseline then covers
  // its own scenarios and the run's extra ones show as "new".
  const compatible = Array.isArray(current.scenariosCompatibleWith) ? current.scenariosCompatibleWith : [];
  if (baseline.scenariosVersion !== current.scenariosVersion && !compatible.includes(baseline.scenariosVersion)) {
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

const range = (xs) => {
  const v = (xs || []).filter((x) => x != null && Number.isFinite(x));
  return v.length >= 2 ? Math.max(...v) - Math.min(...v) : null;
};

/**
 * Verdict for one metric of a paired comparison (`a` = before, `b` = after).
 * `spread` is the larger of the two runs' sample ranges in the metric's unit
 * (null when a file carries no samples). A delta that does not exceed the
 * spread is "no-result": the run-to-run noise explains it.
 *  - regression: past the gate (gatePct, and floor in the metric's unit)
 *  - worse / better: a real change of at least betterPct, under the gate / an improvement
 *  - flat: a real change smaller than betterPct
 */
export function metricVerdict({ a, b, spread, gatePct, floor = 0, betterPct = 5 }) {
  if (a == null || b == null) return { verdict: 'n/a', deltaPct: null, delta: null, spreadKnown: spread != null };
  const delta = b - a;
  const deltaPct = pctChange(a, b);
  let verdict;
  if (spread != null && Math.abs(delta) <= spread) verdict = 'no-result';
  else if (deltaPct > gatePct && delta > floor) verdict = 'regression';
  else if (deltaPct >= betterPct) verdict = 'worse';
  else if (deltaPct <= -betterPct) verdict = 'better';
  else verdict = 'flat';
  return { verdict, delta, deltaPct, spread, spreadKnown: spread != null };
}

/**
 * Paired, spread-aware comparison of two results files (`--compare a b`), for
 * judging one change without a committed baseline. Per scenario: billable
 * tokens, hops, time to first token and total time, each with a verdict.
 * Gates (plan 6.1): tokens +15%, time +30% (and the floor), median hops +20%.
 * @returns {{ rows: object[], failed: boolean }}
 */
export function compareRuns(a, b, {
  tokenPct = 15, timePct = 30, timeFloorMs = 500, hopsPct = 20,
} = {}) {
  const bById = new Map(b.scenarios.map((s) => [s.id, s]));
  const rows = [];
  for (const sa of a.scenarios) {
    const sb = bById.get(sa.id);
    if (!sb) { rows.push({ id: sa.id, status: 'only-in-a', failed: false }); continue; }
    const spread = (xa, xb) => {
      const ra = range(xa); const rb = range(xb);
      return ra == null && rb == null ? null : Math.max(ra ?? 0, rb ?? 0);
    };
    const tokens = metricVerdict({
      a: sa.billableTokens, b: sb.billableTokens, spread: spread(sa.billableSamples, sb.billableSamples), gatePct: tokenPct,
    });
    const hops = metricVerdict({
      a: sa.hops, b: sb.hops, spread: spread(sa.hopsSamples, sb.hopsSamples), gatePct: hopsPct,
    });
    const ttft = metricVerdict({
      a: sa.ttftMs, b: sb.ttftMs, spread: spread(sa.ttftMsSamples, sb.ttftMsSamples), gatePct: timePct, floor: timeFloorMs,
    });
    const time = metricVerdict({
      a: sa.totalMs, b: sb.totalMs, spread: spread(sa.totalMsSamples, sb.totalMsSamples), gatePct: timePct, floor: timeFloorMs,
    });
    const failed = [tokens, hops, time].some((m) => m.verdict === 'regression');
    rows.push({
      id: sa.id, status: failed ? 'REGRESSION' : 'ok', failed, tokens, hops, ttft, time,
      helperA: sa.helperBillableTokens ?? null, helperB: sb.helperBillableTokens ?? null,
    });
  }
  for (const sb of b.scenarios) {
    if (!a.scenarios.some((x) => x.id === sb.id)) rows.push({ id: sb.id, status: 'only-in-b', failed: false });
  }
  return { rows, failed: rows.some((r) => r.failed) };
}

/** Text report for compareRuns. */
export function formatCompare(a, b, comparison, labels = ['A', 'B']) {
  const f = (n) => (n == null ? '-' : Math.round(n).toLocaleString('en-US'));
  const pct = (n) => (n == null || !Number.isFinite(n) ? '-' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);
  const cell = (m, base, cur) => `${f(base)} -> ${f(cur)} (${pct(m.deltaPct)}${m.spreadKnown ? `, spread ${f(m.spread)}` : ', no samples'}) ${m.verdict}`;
  const lines = [];
  lines.push(`A = ${labels[0]}  (${a.model}, repeat ${a.repeat}, env ${JSON.stringify(a.env || {})})`);
  lines.push(`B = ${labels[1]}  (${b.model}, repeat ${b.repeat}, env ${JSON.stringify(b.env || {})})`);
  lines.push('a delta no larger than the sample spread is "no-result"; gates: tokens/time/hops per the thresholds');
  const byIdA = new Map(a.scenarios.map((s) => [s.id, s]));
  const byIdB = new Map(b.scenarios.map((s) => [s.id, s]));
  for (const r of comparison.rows) {
    lines.push('');
    if (r.status === 'only-in-a' || r.status === 'only-in-b') { lines.push(`${r.id}: ${r.status} (not compared)`); continue; }
    const sa = byIdA.get(r.id); const sb = byIdB.get(r.id);
    lines.push(`${r.id}  [${r.status}]`);
    lines.push(`  billable  ${cell(r.tokens, sa.billableTokens, sb.billableTokens)}`);
    lines.push(`  hops      ${cell(r.hops, sa.hops, sb.hops)}`);
    lines.push(`  ttft ms   ${cell(r.ttft, sa.ttftMs, sb.ttftMs)}`);
    lines.push(`  total ms  ${cell(r.time, sa.totalMs, sb.totalMs)}`);
    if (r.helperA != null || r.helperB != null) {
      lines.push(`  helper calls (classifier/memory, not in billable)  ${f(r.helperA)} -> ${f(r.helperB)} billable`);
    }
  }
  return lines.join('\n');
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

/** Session-router scenario fields (K1 Phase 6b): `route: { tokenLimit?, expectRefusal?, steps: [{ before, provider, model }] }`. */
function validateRoute(file, s) {
  const r = s.route;
  const bad = (why) => { throw new Error(`${file}: scenario ${s.id}: route ${why}`); };
  if (!r || typeof r !== 'object' || Array.isArray(r)) bad('must be an object');
  if (r.tokenLimit !== undefined && (!Number.isSafeInteger(r.tokenLimit) || r.tokenLimit < 1)) bad('tokenLimit must be a positive integer');
  if (r.expectRefusal !== undefined && typeof r.expectRefusal !== 'boolean') bad('expectRefusal must be a boolean');
  if (r.steps !== undefined) {
    if (!Array.isArray(r.steps)) bad('steps must be an array');
    for (const st of r.steps) {
      if (!Number.isInteger(st?.before) || st.before < 0 || st.before >= s.turns.length) bad(`step "before" must be a turn index in 0..${s.turns.length - 1}`);
      if (!(st.provider === 'anthropic' || /^custom:/.test(st.provider ?? '')) || typeof st.model !== 'string' || !st.model) bad('step needs provider (anthropic or custom:*) and model');
    }
  }
}

export function loadScenarios(file = DEFAULT_SCENARIOS) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(cfg.scenarios) || cfg.scenarios.length === 0) throw new Error(`${file}: no scenarios`);
  for (const s of cfg.scenarios) {
    if (!s.id || !s.mode || !Array.isArray(s.turns) || s.turns.length === 0) {
      throw new Error(`${file}: scenario needs id, mode and turns: ${JSON.stringify(s)}`);
    }
    // An auto mode is the point of a `classifier: true` scenario (v3 auto-mode)
    // and a mistake anywhere else: it would put the classifier in the measurement.
    if (FORBIDDEN_MODES.has(s.mode) && s.classifier !== true) {
      throw new Error(`${file}: scenario ${s.id} uses mode "${s.mode}"; the bench pins explicit modes (the classifier would be part of the measurement)`);
    }
    if (s.turnModes !== undefined) {
      if (!Array.isArray(s.turnModes) || s.turnModes.length !== s.turns.length
        || s.turnModes.some((m) => typeof m !== 'string' || FORBIDDEN_MODES.has(m))) {
        throw new Error(`${file}: scenario ${s.id}: turnModes must list one explicit mode per turn`);
      }
    }
    if (s.dropSessionBefore !== undefined) {
      if (!Array.isArray(s.dropSessionBefore)
        || s.dropSessionBefore.some((i) => !Number.isInteger(i) || i < 1 || i >= s.turns.length)) {
        throw new Error(`${file}: scenario ${s.id}: dropSessionBefore must be turn indexes in 1..${s.turns.length - 1}`);
      }
    }
    if (s.route !== undefined) validateRoute(file, s);
    if (s.requiresEnv !== undefined
      && (!Array.isArray(s.requiresEnv) || s.requiresEnv.some((n) => typeof n !== 'string' || !ENV_NAME_RE.test(n)))) {
      throw new Error(`${file}: scenario ${s.id}: requiresEnv must list LLMIDE_* names`);
    }
    if (s.fakeMcp !== undefined && (!Number.isInteger(s.fakeMcp) || s.fakeMcp < 1 || s.fakeMcp > 4)) {
      throw new Error(`${file}: scenario ${s.id}: fakeMcp must be an integer 1..4`);
    }
  }
  const ids = new Set();
  for (const s of cfg.scenarios) {
    if (ids.has(s.id)) throw new Error(`${file}: duplicate scenario id ${s.id}`);
    ids.add(s.id);
  }
  return {
    version: cfg.version,
    compatibleWith: Array.isArray(cfg.compatibleWith) ? cfg.compatibleWith : [],
    scenarios: cfg.scenarios,
  };
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

/** The newest usage_ledger id of a user (0 when none): the cut-off for helper rows. */
export function maxLedgerId(db, userId) {
  return db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM usage_ledger WHERE user_id = ?').get(userId).m;
}

/**
 * Usage rows written after `afterId` that are NOT part of a turn's own rows:
 * the classifier and the per-turn memory extraction call `runClaude` with no
 * request id and no `/agent/v2/stream` endpoint, so the turn metering never
 * sees them. Reported beside the billable tokens, never added to them (that
 * would change comparability with committed baselines).
 * @returns {{ calls: number, billable: number, raw: object }}
 */
export function helperUsageSince(db, userId, afterId) {
  const rows = db.prepare(
    `SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
       FROM usage_ledger
      WHERE user_id = ? AND id > ?
        AND (endpoint IS NULL OR NOT (endpoint = '${LEDGER_ENDPOINT}' OR endpoint LIKE '${LEDGER_ENDPOINT}:%'))`,
  ).all(userId, afterId);
  const raw = rows.reduce((a, r) => ({
    input: a.input + (r.input_tokens || 0),
    output: a.output + (r.output_tokens || 0),
    cacheRead: a.cacheRead + (r.cache_read_tokens || 0),
    cacheWrite: a.cacheWrite + (r.cache_creation_tokens || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  return { calls: rows.length, billable: billableTokens(raw), raw };
}

/**
 * The child server's environment: the caller's, minus every LLMIDE_* variable
 * (and NODE_ENV, NODE_TEST_CONTEXT), plus the bench's own settings. HOME is kept
 * so the Claude CLI login still resolves.
 */
export function buildChildEnv(base, {
  port, dbPath, jwtSecret, vaultKey, fake, extraEnv = {}, pluginDir = null,
}) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.startsWith('LLMIDE_') || k === 'NODE_ENV' || k === 'NODE_TEST_CONTEXT') continue;
    env[k] = v;
  }
  // --env values are applied after the strip and BEFORE the bench's own
  // settings, which therefore always win (reserved names are refused anyway).
  for (const [k, v] of Object.entries(extraEnv)) parseEnvAssignment(`${k}=${v}`);
  Object.assign(env, extraEnv);
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
  if (pluginDir) env.LLMIDE_PLUGIN_DIR = pluginDir;
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

async function startServer({ fake, dir, port, extraEnv, pluginDir }) {
  const env = buildChildEnv(process.env, {
    extraEnv,
    pluginDir,
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

async function streamTurn({
  base, token, chatSessionId, workspaceRoot, mode, model, message, extraBody = {},
}) {
  // accept-edits: the bench workspace is a throwaway temp dir, and with the
  // default ('ask') an edit waits on an approval prompt the bench never answers.
  const body = JSON.stringify({
    message, mode, model, provider: 'anthropic', permissionMode: 'accept-edits',
    agentContext: { chatSessionId, workspaceRoot },
    ...extraBody,
  });
  // `started` is the successful attempt's request start, so waits for the
  // limiter are not billed as turn time.
  const { res, started } = await openTurnStream(body, base, token);
  let ttftMs = null;
  let error = null;
  let sdkSessionId = null;
  let declined = 0;
  let reply = '';
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
        if (ev.type === 'delta' && typeof ev.text === 'string') reply += ev.text;
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
  return { ttftMs, totalMs: performance.now() - started, error, declined, reply };
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

async function dropSdkSession(ctx, chatSessionId) {
  const r = await fetch(`${ctx.base}/agent/v2/session`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: JSON.stringify({ chatSessionId }),
  });
  if (!r.ok) throw new Error(`drop session HTTP ${r.status}: ${await r.text()}`);
}

async function authedJson(ctx, method, url, body) {
  const r = await fetch(`${ctx.base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${method} ${url} HTTP ${r.status}: ${await r.text()}`);
  return r.json();
}

/** Registers, consents to and enables `count` stub stdio MCP servers for the bench user. */
export async function enableFakeMcpServers(ctx, count) {
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const added = await authedJson(ctx, 'POST', '/auth/me/mcp-plugins/add', {
      name: `benchmcp${i}`, command: process.execPath, args: [FIXTURE_MCP, `benchmcp${i}`],
    });
    const id = added.plugin.id;
    await authedJson(ctx, 'POST', '/auth/me/mcp-plugins/consent', { id, consented: true });
    await authedJson(ctx, 'POST', '/auth/me/mcp-plugins/toggle', { id, enabled: true });
    ids.push(id);
  }
  return ids;
}

async function removeFakeMcpServers(ctx, ids) {
  for (const id of ids) {
    try { await authedJson(ctx, 'DELETE', `/auth/me/mcp-plugins/${id}`); } catch { /* temp registry */ }
  }
}

/** PUT /agent/v2/session/route. A 409 ROUTER_DISABLED means the run forgot --env LLMIDE_ROUTER=on. */
async function putRoute(ctx, chatSessionId, patch) {
  try {
    return await authedJson(ctx, 'PUT', '/agent/v2/session/route', { chatSessionId, ...patch });
  } catch (err) {
    if (/ROUTER_DISABLED/.test(String(err?.message))) {
      throw new Error('this scenario needs the session router: run with --env LLMIDE_ROUTER=on (and --env LLMIDE_ROUTER_CAP=on for a token limit)');
    }
    throw err;
  }
}

/** One sample of one scenario: a fresh workspace and a fresh chat, every turn metered. */
async function runSample({ scenario, ctx }) {
  seedWorkspace(ctx.workspaceRoot);
  const chatSessionId = randomUUID();
  const turns = [];
  const ledgerMark = maxLedgerId(ctx.ledger, ctx.userId);
  const dropBefore = new Set(scenario.dropSessionBefore || []);
  const history = [];
  const route = scenario.route;
  // Session router (K1 P6b): the cap goes on before the first turn; pin changes go on before their turn.
  if (route?.tokenLimit) await putRoute(ctx, chatSessionId, { tokenLimit: route.tokenLimit });
  let refused = false;
  for (const [index, message] of scenario.turns.entries()) {
    for (const st of route?.steps || []) {
      if (st.before === index) await putRoute(ctx, chatSessionId, { provider: st.provider, model: st.model });
    }
    let extraBody = {};
    if (dropBefore.has(index)) {
      // An ended chat: the SDK session and its transcript are gone, and the
      // client continues the same chat with fresh:true plus its own history
      // (what the Mac sends after SESSION_UNRESUMABLE).
      await dropSdkSession(ctx, chatSessionId);
      extraBody = { fresh: true, history: [...history] };
    }
    // The fake engine has no classifier seam: an auto-mode turn would call the
    // real classifier (a paid model call), so a fake run sends `ask` instead.
    let mode = scenario.turnModes?.[index] ?? scenario.mode;
    if (ctx.fake && FORBIDDEN_MODES.has(mode)) mode = 'ask';
    let t;
    try {
      t = await streamTurn({
        base: ctx.base, token: ctx.token, chatSessionId, workspaceRoot: ctx.workspaceRoot,
        mode, model: ctx.model, message, extraBody,
      });
    } catch (err) {
      // A chat at its session cap is refused with 402 before any model call: for a capped scenario that
      // IS the measurement, so it ends the sample instead of failing it.
      if (route?.expectRefusal && /stream HTTP 402/.test(String(err?.message))) { refused = true; break; }
      throw err;
    }
    history.push({ role: 'user', content: message }, { role: 'assistant', content: t.reply || '(no text)' });
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
  if (route?.expectRefusal && !refused) {
    throw new Error(`scenario ${scenario.id}: expected the chat to be refused at its token limit, but every turn ran`);
  }
  const ttfts = turns.map((t) => t.ttftMs).filter((v) => v != null);
  if (!ctx.fake) await new Promise((r) => setTimeout(r, HELPER_SETTLE_MS));
  const helper = helperUsageSince(ctx.ledger, ctx.userId, ledgerMark);
  return {
    helperBillable: helper.billable,
    helperCalls: helper.calls,
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
    // Sample lists let --compare judge a delta against the run's own spread.
    totalMsSamples: samples.map((s) => s.totalMs),
    ttftMsSamples: samples.map((s) => s.ttftMs),
    hopsSamples: samples.map((s) => s.hops),
    // Classifier / memory-extraction calls the turn rows never see (not in billableTokens).
    helperBillableTokens: median3((s) => s.helperBillable),
    helperCalls: median3((s) => s.helperCalls),
    ...(scenario.classifier ? { classifier: true } : {}),
    ...(scenario.fakeMcp ? { fakeMcp: scenario.fakeMcp } : {}),
    ...(scenario.route ? { route: true } : {}),
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
  fake = false, model, scenarios, scenariosVersion = 1, compatibleWith = [], repeat = DEFAULT_REPEAT,
  extraEnv = {}, log = () => {},
}) {
  for (const sc of scenarios) {
    const missing = (sc.requiresEnv || []).filter((n) => extraEnv[n] !== 'on');
    if (missing.length) throw new Error(`scenario ${sc.id} needs --env ${missing.map((n) => `${n}=on`).join(' --env ')}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-token-bench-'));
  liveDirs.add(dir);
  const workspaceRoot = path.join(dir, 'workspace');
  const port = await freePort();
  // Stub MCP servers are registered in a registry file; keep it in the temp dir,
  // never in the user's real plugins directory.
  const needsMcp = scenarios.some((s) => s.fakeMcp);
  const pluginDir = needsMcp ? path.join(dir, 'plugins', 'p') : null;
  const server = await startServer({ fake, dir, port, extraEnv, pluginDir });
  try {
    const { userId, token } = await registerAndLogin(server.base);
    const { DatabaseSync } = await import('node:sqlite');
    const ledger = new DatabaseSync(path.join(dir, 'bench.db'), { readOnly: true });
    try {
      const ctx = {
        base: server.base, token, userId, ledger, workspaceRoot, model, fake, seenTurnIds: new Set(),
      };
      const results = [];
      for (const scenario of scenarios) {
        const samples = [];
        const mcpIds = scenario.fakeMcp ? await enableFakeMcpServers(ctx, scenario.fakeMcp) : [];
        try {
          for (let i = 0; i < repeat; i += 1) {
            log(`running ${scenario.id} (${i + 1}/${repeat}) ...`);
            samples.push(await runSample({ scenario, ctx }));
          }
        } finally {
          await removeFakeMcpServers(ctx, mcpIds);
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
        scenariosCompatibleWith: compatibleWith,
        env: extraEnv,
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

export function parseArgs(argv) {
  const opts = {
    env: {}, compare: null, only: null,
    fake: false, baseline: false, model: null, baselineFile: DEFAULT_BASELINE, out: null,
    scenarios: DEFAULT_SCENARIOS, repeat: DEFAULT_REPEAT,
    tokenPct: 15, timePct: 30, timeFloorMs: 500, timeAdvisory: false, hopsPct: 20,
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
    else if (a === '--env') {
      const [k, v] = parseEnvAssignment(need(i, a));
      if (k in opts.env) throw new Error(`--env ${k} given twice`);
      opts.env[k] = v; i += 1;
    } else if (a === '--compare') {
      if (argv[i + 1] == null || argv[i + 2] == null || argv[i + 1].startsWith('--') || argv[i + 2].startsWith('--')) {
        throw new Error('--compare needs two results files: --compare a.json b.json');
      }
      opts.compare = [argv[i + 1], argv[i + 2]]; i += 2;
    } else if (a === '--only') {
      opts.only = need(i, a).split(',').map((x) => x.trim()).filter(Boolean); i += 1;
    } else if (a === '--threshold-hops') { opts.hopsPct = Number(need(i, a)); i += 1; }
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
  if (opts.compare && (opts.baseline || opts.fake || Object.keys(opts.env).length || opts.only)) {
    throw new Error('--compare reads two files and runs nothing: it cannot be combined with --baseline, --fake, --env or --only');
  }
  return opts;
}

function installSignalCleanup() {
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(sig, () => {
      cleanupAll().finally(() => process.exit(code));
    });
  }
}

function runCompareCommand(opts) {
  const [fileA, fileB] = opts.compare;
  const a = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const b = JSON.parse(fs.readFileSync(fileB, 'utf8'));
  const problems = comparabilityProblems(b, a);
  if (problems.length) {
    console.error(`${fileA} and ${fileB} are not comparable:\n  ${problems.join('\n  ')}`);
    return 2;
  }
  const comparison = compareRuns(a, b, {
    tokenPct: opts.tokenPct, timePct: opts.timePct, timeFloorMs: opts.timeFloorMs, hopsPct: opts.hopsPct,
  });
  console.log(formatCompare(a, b, comparison, [fileA, fileB]));
  if (comparison.failed) {
    console.log(`\nFAILED: B regressed A by > ${opts.tokenPct}% tokens, > ${opts.timePct}% time (and > ${opts.timeFloorMs} ms) or > ${opts.hopsPct}% hops, beyond the sample spread`);
    return 1;
  }
  console.log('\nPASS: no scenario regressed beyond its spread');
  return 0;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.compare) return runCompareCommand(opts);
  if (opts.baseline && opts.fake) {
    console.error('refusing to write a baseline from --fake: its numbers are synthetic');
    return 2;
  }
  installSignalCleanup();
  const model = opts.model || defaultBenchModel();
  const loaded = loadScenarios(opts.scenarios);
  const { version, compatibleWith } = loaded;
  let { scenarios } = loaded;
  if (opts.only) {
    const unknown = opts.only.filter((id) => !scenarios.some((s) => s.id === id));
    if (unknown.length) throw new Error(`--only: unknown scenario id(s): ${unknown.join(', ')}`);
    scenarios = scenarios.filter((s) => opts.only.includes(s.id));
    if (opts.baseline) throw new Error('--only cannot write a baseline: a baseline must hold the whole scenario set');
  }
  if (!opts.only) {
    // Router scenarios (K1 P6b) need server switches. A default run leaves them out and says so; naming one
    // with --only (and the --env it lists) runs it.
    const skipped = scenarios.filter((s) => (s.requiresEnv || []).some((n) => opts.env[n] !== 'on'));
    if (skipped.length) {
      console.error(`token bench: skipping ${skipped.map((s) => s.id).join(', ')} (they need --env ${[...new Set(skipped.flatMap((s) => s.requiresEnv))].map((n) => `${n}=on`).join(' --env ')} and --only)`);
      scenarios = scenarios.filter((s) => !skipped.includes(s));
    }
  }
  if (Object.keys(opts.env).length) {
    console.error(`token bench: child server env overrides: ${Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  }
  if (!opts.fake) {
    console.error(`token bench: REAL run on ${model} — spends tokens (${scenarios.length} scenarios x ${opts.repeat} repeats).`);
  }
  const current = await runBench({
    fake: opts.fake, model, scenarios, scenariosVersion: version, compatibleWith, repeat: opts.repeat, extraEnv: opts.env, log: (m) => console.error(m),
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
  if (opts.only) baseline.scenarios = baseline.scenarios.filter((b) => opts.only.includes(b.id));
  const problems = comparabilityProblems(current, baseline);
  // A flag-toggled run is a different measurement from the committed baseline.
  if (JSON.stringify(baseline.env || {}) !== JSON.stringify(current.env || {})) {
    problems.push(`env: baseline ${JSON.stringify(baseline.env || {})} vs run ${JSON.stringify(current.env || {})}`);
  }
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
