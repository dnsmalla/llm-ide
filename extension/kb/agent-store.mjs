// agent.db store functions (plan Phase 1 record helpers and Phase 3 store
// core): run and tool-event recording, daily rollup with retention, per-user
// clear with a dry run, compaction, storage stats, retention settings and the
// user purge. Plain functions over kb/agent-db.mjs. Nothing here touches the
// main DB, and no route calls these yet (Stage 1b wires them).
//
// Every per-user helper takes userId first. Pass `{ db }` in tests to use a
// specific handle; the default is the store handle (getAgentDb).

import fs from 'fs';
import path from 'path';
import {
  agentDbFile, agentStoreStatus, checkStorageSize, dropQueuedForUser, enqueueAgentWrite, flushAgentQueue,
  getAgentDb, localDay, localDayBefore, readMeta, writeMeta,
} from './agent-db.mjs';
// Local, not imported from db.mjs: db.mjs imports this module (user purge), so
// importing back would be a cycle. Same rule as db.mjs requireUser.
function requireUser(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required for tenanted operations');
  }
  return userId;
}

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 7;
export const MAX_RETENTION_DAYS = 365;
export const ROLLUP_KEEP_DAYS = 400;
export const KEEP_TURNS_RAW = 50;
export const TOOL_EVENTS_PER_RUN = 200;
export const RUN_SOURCES = new Set(['chat', 'loop', 'meeting', 'autotask', 'dispatch', 'review']);

// Tables that carry user_id. The user purge and the enumerator test use this.
export const AGENT_USER_TABLES = Object.freeze([
  'agent_runs', 'agent_tool_events', 'turn_composition', 'activity', 'activity_seen',
  'agent_daily', 'agent_daily_tools', 'agent_user_settings',
]);

const clampInt = (v) => Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(v) || 0)));
const clampStr = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['ok', 'error', 'cancelled', 'aborted']);

function handleOr(opts) {
  return opts.db ?? getAgentDb();
}

function requireHandle(handle) {
  if (!handle) throw new Error('agent.db is not available');
  return handle;
}

function clampRetention(days) {
  const n = Number(days);
  if (!Number.isFinite(n)) throw new TypeError('retention days must be a number');
  return Math.max(MIN_RETENTION_DAYS, Math.min(MAX_RETENTION_DAYS, Math.trunc(n)));
}

// --- recording (write side, not yet wired) -------------------------------

/**
 * Open a run row now, synchronously, so the Agents hub sees a run that is
 * still going. Returns false on any failure (never throws).
 */
export function openRun(userId, run, { db, now = new Date() } = {}) {
  try {
    requireUser(userId);
    const handle = handleOr({ db });
    if (!handle || !run || typeof run.runId !== 'string' || !run.runId) return false;
    if (!RUN_SOURCES.has(run.source)) return false;
    handle.prepare(
      `INSERT OR IGNORE INTO agent_runs
         (run_id, user_id, day, source, engine, mode, provider, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    ).run(
      clampStr(run.runId, 128), userId, localDay(now), run.source,
      clampStr(run.engine, 16), clampStr(run.mode, 32),
      clampStr(run.provider, 64), clampStr(run.model, 128), now.toISOString(),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Close an open run (queued). Only a run still 'running' is closed, so a
 * second close is a no-op. Tokens are the run's totals, recorded once.
 */
export function enqueueRunClose(userId, runId, close = {}) {
  try {
    requireUser(userId);
    if (typeof runId !== 'string' || !runId) return false;
    const status = STATUSES.has(close.status) ? close.status : 'error';
    const endedAt = close.endedAt instanceof Date ? close.endedAt : new Date();
    return enqueueAgentWrite('runs', `UPDATE agent_runs SET
         status = ?, ended_at = ?, duration_ms = ?, tool_calls = ?,
         input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?,
         stop_reason = ?, error_code = ?
       WHERE user_id = ? AND run_id = ? AND status = 'running'`, [
      status, endedAt.toISOString(),
      clampInt(close.durationMs), clampInt(close.toolCalls),
      clampInt(close.inputTokens), clampInt(close.outputTokens),
      clampInt(close.cacheReadTokens), clampInt(close.cacheCreationTokens),
      clampStr(close.stopReason, 32), clampStr(close.errorCode, 64),
      userId, runId,
    ]);
  } catch {
    return false;
  }
}

/** Queue one run's tool events (names and sizes only, capped per run). */
export function enqueueToolEvents(userId, runId, { day, engine, mode = null, events } = {}) {
  try {
    requireUser(userId);
    if (typeof runId !== 'string' || !runId || !Array.isArray(events)) return 0;
    if (!['v2', 'legacy', 'loop'].includes(engine)) return 0;
    const dayKey = DAY_RE.test(day ?? '') ? day : localDay();
    let queued = 0;
    events.slice(0, TOOL_EVENTS_PER_RUN).forEach((e, seq) => {
      const tool = clampStr(e?.tool, 128);
      if (!tool) return;
      if (enqueueAgentWrite('tool_events',
        `INSERT INTO agent_tool_events (user_id, run_id, day, engine, mode, seq, tool, result_chars, truncated, is_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, runId, dayKey, engine, clampStr(mode, 32), seq, tool,
          clampInt(e.resultChars), e.truncated ? 1 : 0, e.isError ? 1 : 0])) queued += 1;
    });
    return queued;
  } catch {
    return 0;
  }
}

const compositionColumnCache = new WeakMap(); // db -> Set of column names
function compositionColumns(db) {
  let cols = compositionColumnCache.get(db);
  if (!cols) {
    cols = new Set(db.prepare('PRAGMA table_info(turn_composition)').all().map((c) => c.name));
    compositionColumnCache.set(db, cols);
  }
  return cols;
}

/**
 * Queue one turn's composition row. `columns` maps snake_case column names
 * to values; unknown keys are ignored. The allowed names come from the table
 * itself, so a caller key never reaches SQL as an identifier.
 */
export function enqueueTurnComposition(userId, { turnId, day, columns = {} } = {}, { db } = {}) {
  try {
    requireUser(userId);
    if (typeof turnId !== 'string' || !turnId) return false;
    const handle = handleOr({ db });
    if (!handle) return false;
    const allowed = compositionColumns(handle);
    const row = { user_id: userId, turn_id: clampStr(turnId, 128), day: DAY_RE.test(day ?? '') ? day : localDay() };
    for (const [k, v] of Object.entries(columns)) {
      if (allowed.has(k) && !(k in row)) row[k] = v;
    }
    const keys = Object.keys(row);
    return enqueueAgentWrite('composition',
      `INSERT INTO turn_composition (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
      keys.map((k) => row[k]));
  } catch {
    return false;
  }
}

// --- retention settings ---------------------------------------------------

export function getRetentionSettings(userId, { db } = {}) {
  requireUser(userId);
  const handle = handleOr({ db });
  const row = handle?.prepare('SELECT retention_days FROM agent_user_settings WHERE user_id = ?').get(userId);
  return {
    retentionDays: row ? row.retention_days : DEFAULT_RETENTION_DAYS,
    rollupKeepDays: ROLLUP_KEEP_DAYS,
    min: MIN_RETENTION_DAYS,
    max: MAX_RETENTION_DAYS,
  };
}

/** Clamp to 7..365. Takes effect at the next rollup, never deletes now. */
export function setRetentionDays(userId, days, { db, now = new Date() } = {}) {
  requireUser(userId);
  const handle = requireHandle(handleOr({ db }));
  const value = clampRetention(days);
  handle.prepare(
    `INSERT INTO agent_user_settings (user_id, retention_days, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET retention_days = excluded.retention_days, updated_at = excluded.updated_at`,
  ).run(userId, value, now.toISOString());
  return getRetentionSettings(userId, { db: handle });
}

// --- rollup and retention -------------------------------------------------

/**
 * Fold one user's raw history older than `days` into the daily tables, then
 * delete the raw rows. One transaction: a row is either raw or folded, never
 * both, and a second run at the same time changes nothing. Open runs
 * (status 'running') are never folded. The newest KEEP_TURNS_RAW composition
 * rows stay raw whatever their age. Daily rows older than ROLLUP_KEEP_DAYS
 * are dropped.
 */
export function rollupOlderThan(userId, days, { db, now = new Date() } = {}) {
  requireUser(userId);
  const handle = requireHandle(handleOr({ db }));
  const keep = clampRetention(days);
  const horizon = localDayBefore(now, keep);
  const keepCutoff = localDayBefore(now, ROLLUP_KEEP_DAYS);
  return handle.transaction(() => {
    const runsFolded = handle.prepare(
      `SELECT COUNT(*) AS n FROM agent_runs WHERE user_id = ? AND status <> 'running' AND day < ?`,
    ).get(userId, horizon).n;
    handle.prepare(
      `INSERT INTO agent_daily
         (user_id, day, source, provider, model, runs, runs_error, runs_cancelled, runs_aborted,
          duration_ms, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       SELECT user_id, day, source, COALESCE(provider, ''), COALESCE(model, ''),
              COUNT(*),
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'aborted' THEN 1 ELSE 0 END),
              COALESCE(SUM(duration_ms), 0), SUM(tool_calls),
              SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens)
         FROM agent_runs
        WHERE user_id = ? AND status <> 'running' AND day < ?
        GROUP BY day, source, COALESCE(provider, ''), COALESCE(model, '')
       ON CONFLICT(user_id, day, source, provider, model) DO UPDATE SET
         runs = agent_daily.runs + excluded.runs,
         runs_error = agent_daily.runs_error + excluded.runs_error,
         runs_cancelled = agent_daily.runs_cancelled + excluded.runs_cancelled,
         runs_aborted = agent_daily.runs_aborted + excluded.runs_aborted,
         duration_ms = agent_daily.duration_ms + excluded.duration_ms,
         tool_calls = agent_daily.tool_calls + excluded.tool_calls,
         input_tokens = agent_daily.input_tokens + excluded.input_tokens,
         output_tokens = agent_daily.output_tokens + excluded.output_tokens,
         cache_read_tokens = agent_daily.cache_read_tokens + excluded.cache_read_tokens,
         cache_creation_tokens = agent_daily.cache_creation_tokens + excluded.cache_creation_tokens`,
    ).run(userId, horizon);
    handle.prepare(`DELETE FROM agent_runs WHERE user_id = ? AND status <> 'running' AND day < ?`)
      .run(userId, horizon);

    const toolEventsFolded = handle.prepare(
      'SELECT COUNT(*) AS n FROM agent_tool_events WHERE user_id = ? AND day < ?',
    ).get(userId, horizon).n;
    handle.prepare(
      `INSERT INTO agent_daily_tools (user_id, day, engine, tool, calls, errors, truncated, result_chars)
       SELECT user_id, day, engine, tool, COUNT(*), SUM(is_error), SUM(truncated), SUM(result_chars)
         FROM agent_tool_events
        WHERE user_id = ? AND day < ?
        GROUP BY day, engine, tool
       ON CONFLICT(user_id, day, engine, tool) DO UPDATE SET
         calls = agent_daily_tools.calls + excluded.calls,
         errors = agent_daily_tools.errors + excluded.errors,
         truncated = agent_daily_tools.truncated + excluded.truncated,
         result_chars = agent_daily_tools.result_chars + excluded.result_chars`,
    ).run(userId, horizon);
    handle.prepare('DELETE FROM agent_tool_events WHERE user_id = ? AND day < ?').run(userId, horizon);

    const compositionsPruned = handle.prepare(
      `SELECT COUNT(*) AS n FROM turn_composition WHERE user_id = ? AND day < ?
         AND id NOT IN (SELECT id FROM turn_composition WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
    ).get(userId, horizon, userId, KEEP_TURNS_RAW).n;
    handle.prepare(
      `DELETE FROM turn_composition WHERE user_id = ? AND day < ?
         AND id NOT IN (SELECT id FROM turn_composition WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(userId, horizon, userId, KEEP_TURNS_RAW);

    const dailyPurged = handle.prepare('DELETE FROM agent_daily WHERE user_id = ? AND day < ?')
      .run(userId, keepCutoff).changes;
    const toolDailyPurged = handle.prepare('DELETE FROM agent_daily_tools WHERE user_id = ? AND day < ?')
      .run(userId, keepCutoff).changes;

    handle.prepare(
      `INSERT INTO agent_user_settings (user_id, retention_days, last_rolled_day, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_rolled_day = CASE
         WHEN agent_user_settings.last_rolled_day IS NULL OR agent_user_settings.last_rolled_day < excluded.last_rolled_day
         THEN excluded.last_rolled_day ELSE agent_user_settings.last_rolled_day END`,
    ).run(userId, keep, horizon, now.toISOString());

    return { horizon, runsFolded, toolEventsFolded, compositionsPruned, dailyPurged, toolDailyPurged };
  })();
}

/**
 * The job: flush the queue, check the size, then roll up every user with
 * their own retention. Each user is its own transaction, so one user's
 * failure does not undo another's rollup.
 */
export function rollupAll({ db, now = new Date() } = {}) {
  const handle = handleOr({ db });
  if (!handle) return { ok: false, reason: 'unavailable', users: [] };
  if (!db) flushAgentQueue();
  // Refresh the size state without re-requesting: the rollup itself must not
  // schedule the next one, or an over-threshold store would roll up every tick.
  checkStorageSize(now.getTime(), { requestRollup: false });
  const rows = handle.prepare(`
    SELECT user_id FROM agent_runs UNION SELECT user_id FROM agent_tool_events
    UNION SELECT user_id FROM turn_composition UNION SELECT user_id FROM agent_daily
    UNION SELECT user_id FROM agent_user_settings`).all();
  const users = [];
  for (const { user_id: userId } of rows) {
    const { retentionDays } = getRetentionSettings(userId, { db: handle });
    users.push({ userId, ...rollupOlderThan(userId, retentionDays, { db: handle, now }) });
  }
  writeMeta(handle, 'last_rollup_at', now.toISOString());
  return { ok: true, users };
}

// --- clear (per user, dry run first) -------------------------------------

function clearWhere(table, userId, cutoff) {
  // A run that is still running keeps its tool events and composition rows: a
  // clear never takes history out from under a live turn. (Its runs row is
  // already kept by the status filter.)
  const live = 'SELECT run_id FROM agent_runs WHERE user_id = ? AND status = \'running\'';
  let sql;
  let args;
  if (table === 'agent_runs') {
    sql = "user_id = ? AND status <> 'running'";
    args = [userId];
  } else if (table === 'agent_tool_events') {
    sql = `user_id = ? AND run_id NOT IN (${live})`;
    args = [userId, userId];
  } else if (table === 'turn_composition') {
    sql = `user_id = ? AND turn_id NOT IN (${live})`;
    args = [userId, userId];
  } else {
    sql = 'user_id = ?';
    args = [userId];
  }
  if (cutoff != null) {
    sql += ' AND day < ?';
    args.push(cutoff);
  }
  return { sql, args };
}

/**
 * Clear one user's agent history.
 *  - scope 'raw': runs (open ones are kept), tool events and composition
 *    rows. Daily rollups are kept.
 *  - scope 'all': the same plus the daily rollups. A clear with no
 *    beforeDays also resets the rollup watermark.
 *  - beforeDays N: only rows with day before (today - N). Omit for all.
 * dryRun returns the counts a real run would delete (same WHERE, same
 * transaction) and deletes nothing. A real run with `expectCounts` refuses
 * with `preview_stale` when the counts have moved since the preview.
 * Activity and live state are never touched.
 */
export function clearHistory(userId, {
  scope, beforeDays = null, dryRun = true, expectCounts = null, db, now = new Date(),
} = {}) {
  requireUser(userId);
  if (scope !== 'raw' && scope !== 'all') throw new TypeError("scope must be 'raw' or 'all'");
  const handle = requireHandle(handleOr({ db }));
  if (!db) flushAgentQueue();
  const cutoff = beforeDays == null
    ? null
    : localDayBefore(now, Math.max(0, Math.trunc(Number(beforeDays) || 0)));
  const tables = ['agent_runs', 'agent_tool_events', 'turn_composition'];
  if (scope === 'all') tables.push('agent_daily', 'agent_daily_tools');
  const counts = { agent_runs: 0, agent_tool_events: 0, turn_composition: 0, agent_daily: 0, agent_daily_tools: 0 };
  return handle.transaction(() => {
    for (const t of tables) {
      const w = clearWhere(t, userId, cutoff);
      counts[t] = handle.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w.sql}`).get(...w.args).n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (dryRun) return { dryRun: true, ok: true, wouldDelete: counts, total };
    if (expectCounts) {
      const same = tables.every((t) => Number(expectCounts[t] ?? -1) === counts[t]);
      if (!same) return { dryRun: false, ok: false, reason: 'preview_stale', wouldDelete: counts, total };
    }
    for (const t of tables) {
      const w = clearWhere(t, userId, cutoff);
      handle.prepare(`DELETE FROM ${t} WHERE ${w.sql}`).run(...w.args);
    }
    handle.prepare(
      `INSERT INTO agent_user_settings (user_id, retention_days, last_cleared_at, last_cleared_scope, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_cleared_at = excluded.last_cleared_at,
         last_cleared_scope = excluded.last_cleared_scope, updated_at = excluded.updated_at`,
    ).run(userId, DEFAULT_RETENTION_DAYS, now.toISOString(), scope, now.toISOString());
    if (scope === 'all' && cutoff == null) {
      handle.prepare('UPDATE agent_user_settings SET last_rolled_day = NULL WHERE user_id = ?').run(userId);
    }
    return { dryRun: false, ok: true, deleted: counts, total };
  })();
}

// --- compact --------------------------------------------------------------

const MB = 1024 * 1024;

function defaultFreeSpace(file) {
  const st = fs.statfsSync(path.dirname(file));
  return Number(st.bavail) * Number(st.bsize);
}

function fileSize(file) {
  let total = 0;
  for (const s of ['', '-wal']) {
    try { total += fs.statSync(file + s).size; } catch { /* absent */ }
  }
  return total;
}

/**
 * Reclaim free pages. Incremental slices first, yielding to the event loop
 * between slices (better-sqlite3 is synchronous, so one long call would stall
 * chat and health). A full VACUUM only when the freelist is over 25% of pages
 * and the file is over 50 MB, with room on disk for a copy. Refuses with
 * reason 'busy' while `inFlight()` reports active runs.
 */
export async function compact({
  db, inFlight = () => false, sliceMs = 2000, slicePages = 200,
  freeSpace = defaultFreeSpace, file = agentDbFile(), now = () => Date.now(),
  yieldFn = () => new Promise((resolve) => { setTimeout(resolve, 0); }),
} = {}) {
  const handle = handleOr({ db });
  if (!handle) return { ok: false, reason: 'unavailable' };
  if (inFlight()) return { ok: false, reason: 'busy' };
  if (!db) flushAgentQueue();
  const started = now();
  const bytesBefore = fileSize(file);
  const freeBefore = handle.pragma('freelist_count', { simple: true });
  let freeNow = freeBefore;
  let mode = 'incremental';
  let busy = false;
  while (freeNow > 0 && now() - started < sliceMs) {
    if (inFlight()) { busy = true; break; }
    handle.pragma(`incremental_vacuum(${slicePages})`);
    freeNow = handle.pragma('freelist_count', { simple: true });
    await yieldFn();
  }
  const pageCount = handle.pragma('page_count', { simple: true });
  if (!busy && pageCount > 0 && freeNow / pageCount > 0.25 && bytesBefore > 50 * MB) {
    if (inFlight()) {
      busy = true;
    } else if (freeSpace(file) < 2 * bytesBefore) {
      return { ok: false, reason: 'disk_space', mode, bytesBefore, bytesAfter: fileSize(file) };
    } else {
      handle.exec('VACUUM');
      mode = 'full';
    }
  }
  const bytesAfter = fileSize(file);
  const pagesFreed = Math.max(0, freeBefore - handle.pragma('freelist_count', { simple: true }));
  const ms = now() - started;
  if (busy) return { ok: false, reason: 'busy', mode, pagesFreed, bytesBefore, bytesAfter, ms };
  writeMeta(handle, 'last_compact_at', new Date(now()).toISOString());
  return { ok: true, mode, pagesFreed, bytesBefore, bytesAfter, ms };
}

// --- storage stats --------------------------------------------------------

/**
 * Sizes and counts for the Storage hub. File sizes are exact. Per-user bytes
 * are an estimate (the user's share of the used pages, by row count) and are
 * flagged `bytesIsApprox`.
 */
export function storageStats(userId, { db, now = new Date() } = {}) {
  requireUser(userId);
  const handle = handleOr({ db });
  if (!handle) return { ok: false, store: agentStoreStatus() };
  const file = db ? (handle.name ?? agentDbFile()) : agentDbFile();
  const pageSize = handle.pragma('page_size', { simple: true });
  const pageCount = handle.pragma('page_count', { simple: true });
  const freelist = handle.pragma('freelist_count', { simple: true });
  const TABLES = ['agent_runs', 'agent_tool_events', 'turn_composition', 'activity', 'agent_daily', 'agent_daily_tools'];
  const rows = {};
  let totalRows = 0;
  let userRows = 0;
  for (const t of TABLES) {
    rows[t] = handle.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(userId).n;
    totalRows += handle.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    userRows += rows[t];
  }
  const usedBytes = Math.max(0, (pageCount - freelist) * pageSize);
  const bytesApprox = totalRows > 0 ? Math.round(usedBytes * (userRows / totalRows)) : 0;
  const rolled = handle.prepare(
    'SELECT MIN(day) AS oldest, MAX(day) AS newest, COUNT(DISTINCT day) AS n FROM agent_daily WHERE user_id = ?',
  ).get(userId);
  const rawOldest = handle.prepare('SELECT MIN(day) AS oldest FROM agent_runs WHERE user_id = ?').get(userId);
  const settings = handle.prepare(
    'SELECT retention_days, last_rolled_day, last_cleared_at, last_cleared_scope FROM agent_user_settings WHERE user_id = ?',
  ).get(userId);
  const store = agentStoreStatus();
  return {
    ok: true,
    generatedAt: now.toISOString(),
    file: {
      bytes: fileSize(file),
      pageSize,
      pageCount,
      freelistCount: freelist,
      freelistRatio: pageCount > 0 ? Number((freelist / pageCount).toFixed(4)) : 0,
    },
    user: {
      rows,
      bytesApprox,
      bytesIsApprox: true,
      rawOldestDay: rawOldest?.oldest ?? null,
      rolledDays: rolled?.n ?? 0,
      rolledOldestDay: rolled?.oldest ?? null,
      rolledNewestDay: rolled?.newest ?? null,
      retentionDays: settings ? settings.retention_days : DEFAULT_RETENTION_DAYS,
      lastRolledDay: settings?.last_rolled_day ?? null,
      lastClearedAt: settings?.last_cleared_at ?? null,
      lastClearedScope: settings?.last_cleared_scope ?? null,
    },
    store: {
      health: store.health,
      historyResetAt: store.historyResetAt,
      droppedRows: store.droppedRows,
      lastRollupAt: readMeta(handle, 'last_rollup_at'),
      lastCompactAt: readMeta(handle, 'last_compact_at'),
      sizeState: store.sizeState,
    },
  };
}

// --- user purge -------------------------------------------------------------

/**
 * Delete every agent-history row for one user. Queued writes are flushed
 * first so none lands after the purge. Idempotent.
 */
export function purgeUser(userId, { db } = {}) {
  requireUser(userId);
  const handle = requireHandle(handleOr({ db }));
  // Flush first (so no queued row for this user lands after the delete), then
  // drop anything still queued for the user. An explicit handle is flushed too:
  // the queue is process-wide, not per handle.
  flushAgentQueue();
  dropQueuedForUser(userId);
  return handle.transaction(() => {
    const deleted = {};
    for (const t of AGENT_USER_TABLES) {
      deleted[t] = handle.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(userId).changes;
    }
    return { ok: true, deleted };
  })();
}

/**
 * Best-effort purge for deleteUserCascade. Never throws: when the purge
 * cannot run now, a pending marker is left in store_meta so the next boot
 * replays it (Stage 1b boot job). Returns { ok, deleted? , pending? }.
 */
export function purgeUserHistory(userId) {
  try {
    const db = getAgentDb();
    if (!db) return { ok: false, pending: true };
    return purgeUser(userId, { db });
  } catch {
    return { ok: false, pending: true };
  }
}

/**
 * Close runs still 'running' from a previous process (plan 2.5). At boot no
 * run of THIS process exists yet (the boot step runs before listen), so every
 * 'running' row is from a process that died: the default cutoff of 0 closes
 * them all. `olderThanMs` narrows it for an operator sweep. Not per user.
 * Returns the number of rows closed.
 */
export function abortStaleRuns({ db, now = new Date(), olderThanMs = 0 } = {}) {
  const handle = db ?? getAgentDb();
  if (!handle) return 0;
  const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
  return handle.prepare(
    `UPDATE agent_runs SET status = 'aborted', ended_at = ?, error_code = 'stale_run'
      WHERE status = 'running' AND started_at <= ?`,
  ).run(now.toISOString(), cutoff).changes;
}
