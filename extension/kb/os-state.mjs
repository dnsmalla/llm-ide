// SQL-only reads behind GET /kb/os/state (the System view). Every query is
// scoped by user_id; nothing here writes, and nothing calls a model.
//
// The billable weights match scripts/token-bench.mjs: input + output +
// 0.1 x cache read + 1.25 x cache write. A NULL token count (a CLI run that
// reported none) counts as 0; the row still counts as one call and its runs.

import { windowStart, toSqliteLocal } from './usage.mjs';

export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;
// Calendar windows from local midnight, like the model-limit caps
// (kb/usage.mjs windowStart): `day` is today, `week` the last 7 days incl. today.
export const TOKEN_WINDOWS = Object.freeze({
  day: Object.freeze({ days: 1 }),
  week: Object.freeze({ days: 7 }),
});

function windowSince(spec, now) {
  const d = windowStart('daily', now);
  d.setDate(d.getDate() - (spec.days - 1));
  return toSqliteLocal(d);
}

// The kit table of docs/superpowers/plans/2026-10-27-kit-by-kit-migration.md.
// `features` are the LLMIDE_FEATURES keys the kit's server routes depend on;
// an empty list = always on (no key of its own).
const KIT_TABLE = Object.freeze([
  Object.freeze({ id: 'os-kit', features: Object.freeze([]) }),
  Object.freeze({ id: 'knowledge-kit', features: Object.freeze([]) }),
  Object.freeze({ id: 'agent-kit', features: Object.freeze(['agent_chat']) }),
  Object.freeze({ id: 'capture-kit', features: Object.freeze([]) }),
  Object.freeze({ id: 'graph-kit', features: Object.freeze(['code_graph_3d']) }),
  Object.freeze({ id: 'docs-kit', features: Object.freeze(['doc_gen']) }),
  Object.freeze({ id: 'work-kit', features: Object.freeze(['gantt_issues']) }),
  Object.freeze({ id: 'workspace-kit', features: Object.freeze(['file_explorer', 'terminal']) }),
  Object.freeze({ id: 'automation-kit', features: Object.freeze(['auto_tasks']) }),
  Object.freeze({ id: 'sync-kit', features: Object.freeze(['mobile_sync']) }),
]);

/** Billable tokens for one aggregate (same weights as token-bench). */
export function billableOf({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  return Math.round(input + output + cacheRead * CACHE_READ_WEIGHT + cacheWrite * CACHE_WRITE_WEIGHT);
}

/**
 * The kit table with `enabled` derived from the server's feature set.
 * `features` null = every feature; otherwise a Set of enabled keys.
 */
export function kitStatus(features) {
  const on = (key) => features == null || features.has(key);
  return KIT_TABLE.map(({ id, features: keys }) => ({
    id,
    requires: [...keys],
    enabled: keys.every(on),
  }));
}

function emptyAgg() {
  return { calls: 0, runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addAgg(acc, r) {
  for (const k of Object.keys(emptyAgg())) acc[k] += Number(r[k]) || 0;
}

function bucket(map, key, labels, r) {
  let entry = map.get(key);
  if (!entry) {
    entry = { ...labels, ...emptyAgg() };
    map.set(key, entry);
  }
  addAgg(entry, r);
}

function finish(map) {
  return [...map.values()]
    .map((e) => ({ ...e, billable: billableOf(e) }))
    .sort((a, b) => b.billable - a.billable);
}

/**
 * Usage for one window, grouped by model, by source and by endpoint.
 * `window` is a key of TOKEN_WINDOWS; an unknown value falls back to day.
 */
export function usageForWindow(db, userId, window, now = new Date()) {
  const key = Object.hasOwn(TOKEN_WINDOWS, window) ? window : 'day';
  const spec = TOKEN_WINDOWS[key];
  const rows = db.prepare(
    `SELECT provider, model, source, COALESCE(endpoint, '') AS endpoint,
            COUNT(*) AS calls,
            COALESCE(SUM(runs), 0) AS runs,
            COALESCE(SUM(input_tokens), 0) AS input,
            COALESCE(SUM(output_tokens), 0) AS output,
            COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
            COALESCE(SUM(cache_creation_tokens), 0) AS cacheWrite
       FROM usage_ledger
      WHERE user_id = ? AND ts >= ?
      GROUP BY provider, model, source, endpoint`,
  ).all(userId, windowSince(spec, now));

  const totals = emptyAgg();
  const byModel = new Map();
  const bySource = new Map();
  const byEndpoint = new Map();
  for (const r of rows) {
    addAgg(totals, r);
    bucket(byModel, `${r.provider}\u0000${r.model}`, { provider: r.provider, model: r.model }, r);
    bucket(bySource, r.source, { source: r.source }, r);
    bucket(byEndpoint, r.endpoint, { endpoint: r.endpoint || null }, r);
  }
  return {
    window: key,
    windowDays: spec.days,
    since: windowSince(spec, now),
    totals: { ...totals, billable: billableOf(totals) },
    byModel: finish(byModel),
    bySource: finish(bySource),
    byEndpoint: finish(byEndpoint),
  };
}

/**
 * Averages over recent v2 turns (rows from kb/turn-composition.mjs, already
 * camelCased). Prefix = the static LLM-IDE parts sent every turn; fences =
 * per-turn injected context. All *Tokens are chars/4 estimates.
 */
export function rollupTurnComposition(turns) {
  const avg = (pick) => {
    let sum = 0;
    let seen = 0;
    for (const t of turns) {
      const v = pick(t);
      if (v == null || !Number.isFinite(Number(v))) continue;
      sum += Number(v);
      seen += 1;
    }
    return seen ? Math.round(sum / seen) : null;
  };
  return {
    turns: turns.length,
    avgFirstCallPromptTokens: avg((t) => t.firstCallPromptTokens),
    avgPrefixTokens: avg((t) => (t.systemPromptTokens ?? 0) + (t.skillsAppendTokens ?? 0) + (t.llmideToolTokens ?? 0)),
    avgFenceTokens: avg((t) => (t.contextFenceTokens ?? 0) + (t.memoryFenceTokens ?? 0) + (t.skillsFenceTokens ?? 0)),
    avgToolResultTokens: avg((t) => t.toolResultTokens),
  };
}

/** Source, meeting, review and outcome counts plus code-graph freshness. */
export function knowledgeCounts(db, userId) {
  const sources = db.prepare(
    `SELECT kind, COUNT(*) AS count, MAX(indexed_at) AS lastIndexedAt
       FROM sources WHERE user_id = ? GROUP BY kind ORDER BY kind`,
  ).all(userId);
  const meetings = db.prepare('SELECT COUNT(*) AS count FROM meetings WHERE user_id = ?').get(userId);
  const pending = db.prepare(
    `SELECT COUNT(*) AS count FROM review_items WHERE user_id = ? AND status = 'pending'`,
  ).get(userId);
  const outcomeRows = db.prepare(
    `SELECT state, COUNT(*) AS count, COALESCE(SUM(is_terminal), 0) AS terminal
       FROM outcomes WHERE user_id = ? GROUP BY state ORDER BY state`,
  ).all(userId);
  const codeGraph = db.prepare(
    `SELECT repo_id AS repoId, commit_sha AS commitSha, generated_at AS generatedAt
       FROM code_graph_meta WHERE user_id = ? ORDER BY repo_id`,
  ).all(userId);
  const byState = {};
  let outcomeTotal = 0;
  let outcomeTerminal = 0;
  for (const r of outcomeRows) {
    byState[r.state] = r.count;
    outcomeTotal += r.count;
    outcomeTerminal += Number(r.terminal) || 0;
  }
  return {
    sources: {
      total: sources.reduce((n, r) => n + r.count, 0),
      byKind: sources,
    },
    meetings: { count: meetings ? meetings.count : 0 },
    pendingReviews: pending ? pending.count : 0,
    outcomes: { total: outcomeTotal, terminal: outcomeTerminal, byState },
    codeGraph,
  };
}
