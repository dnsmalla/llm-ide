// Usage shadow in agent.db (Stage 2a, plan section 0.1 and 2.3). The main DB's
// usage_ledger stays authoritative; this module only MIRRORS it into agent.db's
// usage_calls and COMPARES the two. Nothing here changes an enforcement read.
//
//   mirrorUsageCall(row)           sync, after the ledger insert in recordUsage.
//                                   Takes the values the ledger stored (same ts,
//                                   request_id, tokens). Never throws.
//   pruneUsageCalls(now)            raw retention, the ledger's 90 days.
//   compareLedgerShadow(userId?)    per window, per user+provider+model, compares
//                                   the ledger's sums with usage_calls. Stores the
//                                   result in store_meta and logs a warning on a
//                                   mismatch. This is the evidence gate for the
//                                   cutover (Stage 2b).
//
// Metadata only: no prompt, response or error text is read or written here.

import { getAgentDb, noteAgentWriteFailure, readMeta, writeMeta } from './agent-db.mjs';
import { getDb } from './db.mjs';
import { toSqliteLocal, windowStart } from './usage.mjs';

export const USAGE_RETENTION_DAYS = 90;
export const USAGE_FLOOR_KEY = 'usage_copy_floor';
export const USAGE_CUTOFF_KEY = 'usage_copy_cutoff';
export const SHADOW_META_KEY = 'last_shadow_compare';
export const SHADOW_MISMATCH_KEY = 'shadow_mismatches';
// Windows the compare checks, in local days (today = 1). Same local-midnight
// rule as the budget windows (windowStart in kb/usage.mjs).
export const SHADOW_WINDOWS = Object.freeze([
  { key: 'today', days: 1 },
  { key: 'days7', days: 7 },
  { key: 'days30', days: 30 },
]);
const SAMPLE_CAP = 10;

// Per-handle cache: the floor check (one readMeta) runs until it first passes,
// and the prepared insert is built once per handle.
const handleCache = new WeakMap();
function handleState(agentDb) {
  let st = handleCache.get(agentDb);
  if (!st) { st = { floor: false, insert: null }; handleCache.set(agentDb, st); }
  return st;
}

/**
 * True once the boot step has set the id floor on this handle. Until then the
 * mirror writes nothing: a row written before the floor exists would take an id
 * that the backfill later copies from the ledger (boot-order collision).
 */
export function usageFloorReady(agentDb) {
  const st = handleState(agentDb);
  if (st.floor) return true;
  try {
    if (readMeta(agentDb, USAGE_FLOOR_KEY) == null) return false;
  } catch {
    return false;
  }
  st.floor = true;
  return true;
}

const MIRROR_SQL = `INSERT INTO usage_calls
  (user_id, day, ts, provider, model, source, endpoint, is_internal,
   input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
   runs, request_id, turns, stop_reason)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** Same rule as the readers' `endpoint NOT LIKE '%:internal'` (case-insensitive). */
export function isInternalEndpoint(endpoint) {
  return typeof endpoint === 'string' && /:internal$/i.test(endpoint) ? 1 : 0;
}

/** The shadow row for one ledger row. `day` is the date part of its local `ts`. */
export function shadowRowFromLedger(r) {
  return [
    r.user_id, String(r.ts).slice(0, 10), r.ts, r.provider, r.model, r.source ?? 'api',
    r.endpoint ?? null, isInternalEndpoint(r.endpoint),
    r.input_tokens ?? null, r.output_tokens ?? null, r.cache_read_tokens ?? null,
    r.cache_creation_tokens ?? null, r.runs ?? 1, r.request_id ?? null,
    r.turns ?? null, r.stop_reason ?? null,
  ];
}

/**
 * Mirror one ledger row into agent.db, synchronously, right after the ledger
 * insert. `row` holds exactly the values the ledger stored (including `ts`), so
 * no read-back is needed. Resolves the handle inside its own try, and never
 * throws: a missing store is silent, a failing write is counted by the store.
 * Writes nothing until the boot step has set the id floor. Returns true when
 * the row was written.
 */
export function mirrorUsageCall(row, opts = {}) {
  try {
    // An explicit `agentDb: null` means "no store" (tests, down store), not "use the default".
    const handle = 'agentDb' in opts ? opts.agentDb : getAgentDb();
    if (!handle || !row) return false;
    if (!usageFloorReady(handle)) return false;
    const st = handleState(handle);
    st.insert ??= handle.prepare(MIRROR_SQL);
    st.insert.run(...shadowRowFromLedger(row));
    return true;
  } catch (err) {
    noteAgentWriteFailure(err);
    return false;
  }
}

/** Drop raw shadow rows older than the ledger's retention (same cutoff rule as maybePruneLedger). */
export function pruneUsageCalls({ agentDb = getAgentDb(), now = new Date() } = {}) {
  if (!agentDb) return 0;
  const cutoff = toSqliteLocal(new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000));
  return agentDb.prepare('DELETE FROM usage_calls WHERE ts < ?').run(cutoff).changes;
}

/** Local midnight `days - 1` days before today, as the SQLite local string. */
export function shadowWindowCutoff(days, now = new Date()) {
  const d = windowStart('daily', now);
  d.setDate(d.getDate() - (days - 1));
  return toSqliteLocal(d);
}

// Per user+provider+model sums. Each side is a literal query (the SQL inventory
// guard reads these FROM clauses). The shadow also checks its own `day` against
// `ts`; the ledger has no day column, so its badDay is 0 by definition.
const COMMON_AGG = `COUNT(*) AS n,
  COALESCE(SUM(runs), 0) AS runs,
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
  COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreation,
  COALESCE(SUM(turns), 0) AS turns,
  COUNT(turns) AS turnRows,
  SUM(CASE WHEN input_tokens IS NULL AND output_tokens IS NULL
            AND cache_read_tokens IS NULL AND cache_creation_tokens IS NULL
           THEN 1 ELSE 0 END) AS unknownRows,
  SUM(CASE WHEN endpoint IS NULL THEN 1 ELSE 0 END) AS nullEndpoint,
  SUM(CASE WHEN source = 'api' THEN 1 ELSE 0 END) AS srcApi,
  SUM(CASE WHEN source = 'cli' THEN 1 ELSE 0 END) AS srcCli,
  SUM(CASE WHEN source = 'auto-task' THEN 1 ELSE 0 END) AS srcAuto`;
const COMPARE_FIELDS = [
  'n', 'runs', 'input', 'output', 'cacheRead', 'cacheCreation', 'turns', 'turnRows', 'unknownRows',
  'nullEndpoint', 'srcApi', 'srcCli', 'srcAuto', 'internal', 'badDay',
];

function ledgerAggregate(db, cutoff, userId) {
  const userSql = userId ? ' AND user_id = ?' : '';
  const args = userId ? [cutoff, userId] : [cutoff];
  return db.prepare(
    `SELECT user_id, provider, model, ${COMMON_AGG},
       COALESCE(SUM(CASE WHEN endpoint LIKE '%:internal' THEN 1 ELSE 0 END), 0) AS internal,
       0 AS badDay
     FROM usage_ledger WHERE ts >= ?${userSql}
     GROUP BY user_id, provider, model`,
  ).all(...args);
}

function shadowAggregate(db, cutoff, userId) {
  const userSql = userId ? ' AND user_id = ?' : '';
  const args = userId ? [cutoff, userId] : [cutoff];
  return db.prepare(
    `SELECT user_id, provider, model, ${COMMON_AGG},
       COALESCE(SUM(is_internal), 0) AS internal,
       COALESCE(SUM(CASE WHEN day <> substr(ts, 1, 10) THEN 1 ELSE 0 END), 0) AS badDay
     FROM usage_calls WHERE ts >= ?${userSql}
     GROUP BY user_id, provider, model`,
  ).all(...args);
}

function byKey(rows) {
  const out = new Map();
  for (const r of rows) out.set(`${r.user_id}\u0000${r.provider}\u0000${r.model}`, r);
  return out;
}

/**
 * Compare the ledger with the shadow for each window. Per user, provider and
 * model it compares the row count, runs, the four token sums, turns and the
 * unknown-row count. Pass `userId` to compare one user. Runs synchronously, so
 * no write lands between the two reads. Returns { ok, reason? , at, windows,
 * mismatches, sample }. The result is also stored in store_meta.
 */
export function compareLedgerShadow(userId = null, {
  mainDb = getDb(), agentDb = getAgentDb(), now = new Date(), logger = null,
} = {}) {
  if (!agentDb) return { ok: false, reason: 'unavailable' };
  const at = now.toISOString();
  const windows = {};
  const sample = [];
  let mismatches = 0;
  for (const w of SHADOW_WINDOWS) {
    const cutoff = shadowWindowCutoff(w.days, now);
    const ledger = byKey(ledgerAggregate(mainDb, cutoff, userId));
    const shadow = byKey(shadowAggregate(agentDb, cutoff, userId));
    const keys = new Set([...ledger.keys(), ...shadow.keys()]);
    let mismatchedKeys = 0;
    let ledgerRows = 0;
    let shadowRows = 0;
    for (const key of keys) {
      const a = ledger.get(key);
      const b = shadow.get(key);
      ledgerRows += a?.n ?? 0;
      shadowRows += b?.n ?? 0;
      const diffs = COMPARE_FIELDS.filter((f) => Number(a?.[f] ?? 0) !== Number(b?.[f] ?? 0));
      if (diffs.length === 0) continue;
      mismatchedKeys += 1;
      mismatches += 1;
      if (sample.length < SAMPLE_CAP) {
        const [, provider, model] = key.split('\u0000');
        sample.push({ window: w.key, provider, model, fields: diffs });
      }
    }
    windows[w.key] = { cutoff, ledgerRows, shadowRows, mismatchedKeys };
  }
  const result = { ok: mismatches === 0, at, scope: userId ? 'user' : 'all', windows, mismatches, sample };
  try {
    writeMeta(agentDb, SHADOW_META_KEY, JSON.stringify(result));
    writeMeta(agentDb, SHADOW_MISMATCH_KEY, String(mismatches));
  } catch (err) {
    noteAgentWriteFailure(err);
  }
  if (mismatches > 0) {
    try { logger?.warn?.('agent_usage_shadow_mismatch', { mismatches, windows: Object.keys(windows) }); } catch { /* logging is best effort */ }
  }
  return result;
}

/** The last stored compare, or null. Safe on any handle. */
export function lastShadowCompare(agentDb = getAgentDb()) {
  if (!agentDb) return null;
  try {
    const raw = readMeta(agentDb, SHADOW_META_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
