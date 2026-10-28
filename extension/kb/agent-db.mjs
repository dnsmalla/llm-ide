// agent.db core (Stage 1a): the separate SQLite file that holds agent-run
// history. See docs/superpowers/plans/2026-10-28-agent-store.md section 2.4.
//
// Contract, in short:
//   - Opened lazily (getAgentDb) or at boot (openAgentDb). Never throws: a
//     store that cannot open is `down`, and callers get null.
//   - A corrupt file is quarantined under a UNIQUE name (never overwriting an
//     earlier quarantine) and a fresh file is created. The reset is recorded
//     in store_meta so the Storage hub can say history was reset.
//   - Writes go through a bounded, batched queue. Enqueueing never throws and
//     never blocks a model turn. Rows over the cap are dropped and counted.
//   - Live state is never stored here. Nothing in this module reads or writes
//     the main DB.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../core/config.mjs';
import { applyMigrations, AGENT_MIGRATIONS_DIR } from './migrations.mjs';

export const AGENT_MIGRATIONS_TABLE = 'agent_schema_migrations';
export const QUEUE_MAX = 5000;
export const QUEUE_FLUSH_ROWS = 200;
export const QUEUE_FLUSH_MS = 250;
export const SIZE_CHECK_MS = 10 * 60 * 1000;
export const DEFAULT_SOFT_BYTES = 256 * 1024 * 1024;
export const DEFAULT_HARD_BYTES = 1024 * 1024 * 1024;

// Write kinds. `hard` size blocks the two bulk kinds; run closes, the open
// rows and the activity feed keep working so the Agents hub stays truthful.
const WRITE_KINDS = new Set(['runs', 'tool_events', 'composition', 'activity']);
const BLOCKED_AT_HARD = new Set(['tool_events', 'composition']);

const state = {
  db: null,            // open better-sqlite3 handle (or a test fake)
  file: null,          // path of the open file
  status: 'closed',    // closed | ok | down
  logger: null,
  queue: [],           // { kind, sql, params }
  droppedUnsaved: 0,   // dropped since the last successful persist
  dropped: 0,          // dropped in this process
  writeErrors: 0,      // failed batches in this process
  quarantines: 0,      // quarantines in this process
  sizeState: 'ok',     // ok | soft | hard
  bytes: 0,
  lastSizeCheck: 0,
  rollupRequested: false,
  timer: null,
  immediate: null,
};

const stmtCache = new WeakMap(); // db -> Map<sql, Statement>

function log(level, event, data) {
  try { state.logger?.[level]?.(event, data); } catch { /* logging is best effort */ }
}

/** Local calendar date `YYYY-MM-DD` of a Date: the store's one day key. */
export function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The local calendar date `days` before `now` (DST-safe, like windowStart). */
export function localDayBefore(now, days) {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return localDay(d);
}

/** True for SQLite errors that mean the file itself is damaged. */
export function isCorruptionError(err) {
  const code = err?.code;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT_VTAB') return true;
  return /malformed|not a database/i.test(String(err?.message ?? ''));
}


// --- meta ---------------------------------------------------------------

export function readMeta(db, key) {
  const row = db.prepare('SELECT value FROM store_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function writeMeta(db, key, value) {
  db.prepare(
    `INSERT INTO store_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value));
}

// --- open / close -------------------------------------------------------

function openFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // auto_vacuum only takes effect on an empty file, so set it first.
  const isNew = !fs.existsSync(file) || fs.statSync(file).size === 0;
  const db = new Database(file);
  try {
    if (isNew) db.pragma('auto_vacuum = INCREMENTAL');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('temp_store = MEMORY');
    // quick_check is NOT here: it runs after listen (verifyAgentDb), off the
    // boot critical path. Garbage bytes still fail the pragmas and migrations.
    applyMigrations(db, { dir: AGENT_MIGRATIONS_DIR, table: AGENT_MIGRATIONS_TABLE, logger: state.logger });
    return db;
  } catch (err) {
    try { db.close(); } catch { /* already unusable */ }
    throw err;
  }
}

/** Unique quarantine name: `<file>.corrupt-<stamp>`, then `-2`, `-3`, ... */
export function quarantinePath(file, now = new Date()) {
  const base = `${file}.corrupt-${now.toISOString().replace(/[:.]/g, '-')}`;
  const taken = (p) => ['', '-wal', '-shm'].some((s) => fs.existsSync(p + s));
  let candidate = base;
  for (let n = 2; taken(candidate); n += 1) candidate = `${base}-${n}`;
  return candidate;
}

function moveAside(file, target) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, target + suffix);
  }
}

function closeHandle() {
  const db = state.db;
  state.db = null;
  if (!db) return;
  try { db.close?.(); } catch { /* best effort */ }
}

// Called with the fresh handle after a quarantine recreates the file (set by
// agent-jobs: it re-raises the history id floors, so copied rows can never
// collide with new ones in the new file).
let freshStoreHook = null;
export function onFreshStore(fn) { freshStoreHook = typeof fn === 'function' ? fn : null; }

function quarantineAndRecreate(file, reason) {
  closeHandle();
  const target = quarantinePath(file);
  moveAside(file, target);
  state.quarantines += 1;
  log('error', 'agent_db_quarantined', { reason, quarantine: path.basename(target) });
  const db = openFile(file);
  writeMeta(db, 'history_reset_at', new Date().toISOString());
  try { freshStoreHook?.(db); } catch (err) { log('error', 'agent_db_fresh_hook_failed', { code: err?.code ?? null }); }
  return db;
}

function attach(db, file) {
  state.db = db;
  state.file = file;
  state.status = 'ok';
}

/**
 * Open agent.db (idempotent). Returns the handle, or null when the store is
 * down. Never throws. A corrupt file is quarantined and recreated.
 */
export function openAgentDb({ logger, file = config.agentDbPath } = {}) {
  if (logger) state.logger = logger;
  if (state.db) return state.db;
  try {
    let db;
    try {
      db = openFile(file);
    } catch (err) {
      if (!isCorruptionError(err)) throw err;
      db = quarantineAndRecreate(file, err.message);
    }
    attach(db, file);
    checkStorageSize();
    return db;
  } catch (err) {
    state.status = 'down';
    state.db = null;
    log('error', 'agent_db_open_failed', { code: err?.code ?? null });
    return null;
  }
}

/**
 * PRAGMA quick_check on the open file (Stage 1b: run after listen). A damaged
 * file is quarantined and recreated, as at open. Returns the verdict. Never throws.
 */
export function verifyAgentDb() {
  const db = state.db ?? getAgentDb();
  if (!db) return { ok: false, reason: 'unavailable' };
  let verdict;
  try {
    verdict = db.pragma('quick_check', { simple: true });
  } catch (err) {
    verdict = isCorruptionError(err) ? String(err.message) : null;
    if (verdict === null) return { ok: false, reason: 'check_failed' };
  }
  if (verdict === 'ok') return { ok: true };
  try {
    if (state.file) state.db = quarantineAndRecreate(state.file, `quick_check: ${verdict}`);
    checkStorageSize();
    return { ok: false, reason: 'quarantined' };
  } catch {
    state.status = 'down';
    state.db = null;
    return { ok: false, reason: 'down' };
  }
}

/** The open handle, opening lazily on first use. Null when down or failed. */
export function getAgentDb(opts = {}) {
  if (state.db) return state.db;
  if (state.status !== 'closed') return null;
  return openAgentDb(opts);
}

/** Flush, stop the timer, checkpoint and close. Idempotent. */
export function closeAgentDb() {
  flushAgentQueue({ openIfNeeded: false });
  stopTimer();
  const db = state.db;
  if (db) {
    try { db.pragma?.('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  }
  closeHandle();
  state.status = 'closed';
  state.file = null;
}

/** Test seam: install a handle (or a fake) as the store, or null to reset. */
export function setAgentDbForTests(handle, { file = null } = {}) {
  stopTimer();
  state.queue = [];
  state.droppedUnsaved = 0;
  state.db = handle ?? null;
  state.file = handle ? file : null;
  state.status = handle ? 'ok' : 'closed';
}

// --- write queue --------------------------------------------------------

function dropRows(n) {
  state.dropped += n;
  state.droppedUnsaved += n;
}

function stmtFor(db, sql) {
  let m = stmtCache.get(db);
  if (!m) { m = new Map(); stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) { s = db.prepare(sql); m.set(sql, s); }
  return s;
}

/**
 * Queue one write for the next batch. Never throws, never blocks. Returns
 * false when the row was dropped (down store, hard size, or a full queue).
 */
export function enqueueAgentWrite(kind, sql, params = []) {
  try {
    if (!WRITE_KINDS.has(kind) || typeof sql !== 'string' || !Array.isArray(params)) {
      dropRows(1);
      return false;
    }
    if (state.status === 'down') { dropRows(1); return false; }
    if (state.sizeState === 'hard' && BLOCKED_AT_HARD.has(kind)) { dropRows(1); return false; }
    if (state.queue.length >= QUEUE_MAX) {
      state.queue.shift();          // the oldest row goes, the newest stays
      dropRows(1);
    }
    state.queue.push({ kind, sql, params });
    ensureTimer();
    if (state.queue.length >= QUEUE_FLUSH_ROWS && !state.immediate) {
      state.immediate = setImmediate(() => {
        state.immediate = null;
        flushAgentQueue();
      });
      state.immediate.unref?.();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop queued writes that belong to one user (any queued param equal to the
 * user id). Used before a user purge so no queued row lands after it.
 * Returns the number dropped.
 */
export function dropQueuedForUser(userId) {
  const before = state.queue.length;
  state.queue = state.queue.filter((e) => !e.params.includes(userId));
  const n = before - state.queue.length;
  if (n) dropRows(n);
  return n;
}

function persistDropped(db) {
  const n = state.droppedUnsaved;
  if (!n) return;
  const cur = Number(readMeta(db, 'dropped_rows')) || 0;
  writeMeta(db, 'dropped_rows', cur + n);
  state.droppedUnsaved = 0;
}

/**
 * Write every queued row in one transaction. Returns the number written.
 * Never throws. A failed batch is dropped and counted; a corrupt file is
 * quarantined. `openIfNeeded: false` (used at exit) never opens the file.
 */
export function flushAgentQueue({ openIfNeeded = true } = {}) {
  if (state.queue.length === 0 && state.droppedUnsaved === 0) return 0;
  const db = state.db ?? (openIfNeeded ? getAgentDb() : null);
  const batch = state.queue;
  state.queue = [];
  if (!db) {
    dropRows(batch.length);
    return 0;
  }
  try {
    db.transaction(() => {
      for (const { sql, params } of batch) stmtFor(db, sql).run(...params);
      persistDropped(db);
    })();
    return batch.length;
  } catch (err) {
    // A batch that failed is lost and counted. A failed drop-count persist
    // (empty batch) is retried on the next flush, not logged as a new error.
    if (batch.length > 0) {
      state.writeErrors += 1;
      dropRows(batch.length);
      log('error', 'agent_db_write_failed', { code: err?.code ?? null, rows: batch.length });
    }
    if (isCorruptionError(err) && state.file) {
      try {
        state.db = quarantineAndRecreate(state.file, err.message);
      } catch {
        state.status = 'down';
        state.db = null;
      }
    }
    return 0;
  }
}

/**
 * A synchronous write (not the queue) failed: count it, log it, and quarantine
 * the file when the error means it is damaged. Never throws. The caller has
 * already swallowed the error; this only makes the failure visible in health.
 */
export function noteAgentWriteFailure(err) {
  try {
    state.writeErrors += 1;
    log('error', 'agent_db_write_failed', { code: err?.code ?? null, rows: 1, sync: true });
    if (isCorruptionError(err) && state.file) {
      try {
        state.db = quarantineAndRecreate(state.file, err.message);
      } catch {
        state.status = 'down';
        state.db = null;
      }
    }
  } catch { /* counting a failure must never fail */ }
}

function tick() {
  flushAgentQueue();
  if (Date.now() - state.lastSizeCheck >= SIZE_CHECK_MS) checkStorageSize();
  if (state.queue.length === 0 && state.droppedUnsaved === 0) stopTimer();
}

function ensureTimer() {
  if (state.timer) return;
  state.timer = setInterval(tick, QUEUE_FLUSH_MS);
  state.timer.unref?.();
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  if (state.immediate) clearImmediate(state.immediate);
  state.immediate = null;
}

// Last-chance flush on normal exit. Synchronous, and it never opens the file.
process.once('exit', () => {
  try { flushAgentQueue({ openIfNeeded: false }); } catch { /* exiting */ }
});

// --- size watchdog ------------------------------------------------------

function fileBytes(file) {
  let total = 0;
  for (const s of ['', '-wal']) {
    try { total += fs.statSync(file + s).size; } catch { /* absent */ }
  }
  return total;
}

/**
 * Stat the file and set the size state from the store_meta thresholds
 * (soft_bytes, hard_bytes). Soft and hard both request a rollup. Hard stops
 * tool-event and composition writes (see enqueueAgentWrite).
 */
export function checkStorageSize(now = Date.now(), { requestRollup = true } = {}) {
  const file = state.file ?? config.agentDbPath;
  const bytes = fileBytes(file);
  let soft = DEFAULT_SOFT_BYTES;
  let hard = DEFAULT_HARD_BYTES;
  if (state.db) {
    soft = Number(readMeta(state.db, 'soft_bytes')) || DEFAULT_SOFT_BYTES;
    hard = Number(readMeta(state.db, 'hard_bytes')) || DEFAULT_HARD_BYTES;
  }
  const next = bytes >= hard ? 'hard' : bytes >= soft ? 'soft' : 'ok';
  state.sizeState = next;
  state.bytes = bytes;
  state.lastSizeCheck = now;
  if (next !== 'ok' && requestRollup) state.rollupRequested = true;
  return { state: next, bytes, soft, hard };
}

/** True once per request. The daily job (wired in Stage 1b) takes it. */
export function takeRollupRequest() {
  const was = state.rollupRequested;
  state.rollupRequested = false;
  return was;
}

// --- status -------------------------------------------------------------

/**
 * Health for /health and the Storage hub. `health` is `down` when the store
 * is not open, `degraded` after drops, write failures, a quarantine or a size
 * threshold in this process, and `ok` otherwise.
 */
export function agentStoreStatus() {
  const health = state.status === 'down'
    ? 'down'
    : (state.dropped > 0 || state.writeErrors > 0 || state.quarantines > 0 || state.sizeState !== 'ok')
      ? 'degraded'
      : 'ok';
  let historyResetAt = null;
  let droppedRows = state.dropped;
  if (state.db) {
    try {
      historyResetAt = readMeta(state.db, 'history_reset_at');
      droppedRows = (Number(readMeta(state.db, 'dropped_rows')) || 0) + state.droppedUnsaved;
    } catch { /* unreadable: report the in-process numbers */ }
  }
  let shadow = null;
  if (state.db) {
    try {
      const raw = readMeta(state.db, 'last_shadow_compare');
      if (raw) {
        const last = JSON.parse(raw);
        shadow = { at: last.at, ok: last.ok, mismatches: last.mismatches, scope: last.scope, windows: last.windows };
      }
    } catch { /* unreadable: no compare yet */ }
  }
  return {
    health,
    state: state.status,
    shadow,
    historyResetAt,
    droppedRows,
    droppedThisProcess: state.dropped,
    writeErrors: state.writeErrors,
    quarantinesThisProcess: state.quarantines,
    queued: state.queue.length,
    sizeState: state.sizeState,
    bytes: state.bytes,
  };
}

/** The file the store is (or would be) opened at. */
export function agentDbFile() {
  return state.file ?? config.agentDbPath;
}
