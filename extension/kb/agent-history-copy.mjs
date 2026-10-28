// One-time copy of existing agent history from the main DB into agent.db
// (Stage 1b, plan T2.5). Tables: activity (ids kept, so activity_seen cursors
// still match), activity_seen, turn_tool_events (-> agent_tool_events) and
// turn_composition.
//
// Rules:
//   - Never deletes or changes the main DB. The main tables are read-only here.
//   - Batched by id cursor. Each batch is one agent.db transaction together
//     with its cursor in store_meta, so a kill mid-copy resumes exactly.
//   - Id safety: before any new write, prepareHistoryCopy (run synchronously at
//     boot, before listen) raises each AUTOINCREMENT sequence to the main
//     table's max id. New rows then always get ids above every copied row, so
//     the copy can never collide with them.
//   - Verification: after a table is done, the copied row count equals the main
//     count (rows with id <= the boot-time max, which are exactly the copies).
//   - Best-effort: an error stops the copy for this boot; the next boot resumes.

import { getDb } from './db.mjs';
import { getAgentDb, readMeta, writeMeta } from './agent-db.mjs';
import { isInternalEndpoint, USAGE_FLOOR_KEY, USAGE_CUTOFF_KEY, USAGE_RETENTION_DAYS } from './agent-usage.mjs';
import { toSqliteLocal } from './usage.mjs';

export const COPY_BATCH_ROWS = 5000;
const TABLES = ['activity', 'turn_tool_events', 'turn_composition'];
// Store sequence name per source table (the AUTOINCREMENT table in agent.db).
const SEQ_NAME = { activity: 'activity', turn_tool_events: 'agent_tool_events', turn_composition: 'turn_composition' };

const cursorKey = (t) => `copy_cursor:${t}`;
const doneKey = (t) => `copy_done:${t}`;
const verifiedKey = (t) => `copy_verified:${t}`;

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function maxId(db, table) {
  return db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m;
}

function bumpSequence(agent, name, floor) {
  const cur = agent.prepare('SELECT seq FROM sqlite_sequence WHERE name = ?').get(name)?.seq ?? 0;
  if (cur >= floor) return;
  agent.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name);
  agent.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(name, floor);
}

/**
 * Synchronous, cheap, safe to call on every boot: raises the id sequences of
 * the not-yet-copied tables above the main DB's max id. Must run before the
 * server accepts requests. Returns the floors it set (for tests and logs).
 */
export function prepareHistoryCopy({ mainDb = getDb(), agentDb = getAgentDb() } = {}) {
  if (!agentDb) return null;
  const floors = {};
  for (const table of TABLES) {
    if (!hasTable(mainDb, table) || readMeta(agentDb, doneKey(table))) continue;
    const floor = maxId(mainDb, table);
    bumpSequence(agentDb, SEQ_NAME[table], floor);
    floors[table] = floor;
  }
  prepareUsageCopy(agentDb, mainDb, floors);
  // The read cursors go first, before listen: a copy of the feed without them
  // would show every copied row as unread for the length of the copy.
  if (hasTable(mainDb, 'activity_seen') && !readMeta(agentDb, doneKey('activity_seen'))) {
    copyActivitySeen(agentDb, mainDb);
    writeMeta(agentDb, doneKey('activity_seen'), '1');
    floors.activity_seen = true;
  }
  return floors;
}

// --- usage backfill (Stage 2a) -------------------------------------------
// usage_ledger -> usage_calls. Bounded on both ends: ids <= the boot-time floor
// (rows mirrored live after boot have larger ids and are never copied) and
// ts >= the 90-day cutoff fixed at boot. Both are kept in store_meta so a resumed
// copy uses the same bounds.
//
// Verification compares COUNT and the SUMs of every token, run, turn and
// internal-flag column between the ledger range and the copy. A mismatch never
// writes copy_done: the copied rows are removed and the copy is retried from
// scratch on the next boot, at most USAGE_MAX_ATTEMPTS times per store.
const USAGE_CURSOR_KEY = 'copy_cursor:usage_ledger';
const USAGE_DONE_KEY = 'copy_done:usage_ledger';
const USAGE_VERIFIED_KEY = 'copy_verified:usage_ledger';
const USAGE_ATTEMPTS_KEY = 'usage_copy_attempts';
const USAGE_PENDING_KEY = 'usage_copy_retry_next_boot';
const USAGE_GAVE_UP_KEY = 'usage_copy_gave_up';
export const USAGE_MAX_ATTEMPTS = 3;

/**
 * Boot step (and the bounds-missing branch of the copy). When no floor exists
 * yet, any usage_calls rows are leftovers that would collide with copied ids:
 * the table is only a shadow, so it is emptied before the bounds are set.
 */
function prepareUsageCopy(agent, mainDb, floors) {
  if (!hasTable(mainDb, 'usage_ledger') || readMeta(agent, USAGE_DONE_KEY)) return;
  writeMeta(agent, USAGE_PENDING_KEY, '0');
  if (readMeta(agent, USAGE_FLOOR_KEY) == null) {
    agent.prepare('DELETE FROM usage_calls').run();
    const floor = maxId(mainDb, 'usage_ledger');
    const cutoff = toSqliteLocal(new Date(Date.now() - USAGE_RETENTION_DAYS * 86_400_000));
    writeMeta(agent, USAGE_CURSOR_KEY, 0);
    writeMeta(agent, USAGE_CUTOFF_KEY, cutoff);
    writeMeta(agent, USAGE_FLOOR_KEY, floor);
  }
  const floor = Number(readMeta(agent, USAGE_FLOOR_KEY)) || 0;
  bumpSequence(agent, 'usage_calls', floor);
  floors.usage_ledger = floor;
}

const SUM_COLUMNS = `COUNT(*) AS n,
  COALESCE(SUM(runs), 0) AS runs,
  COALESCE(SUM(input_tokens), 0) AS input,
  COALESCE(SUM(output_tokens), 0) AS output,
  COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
  COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreation,
  COALESCE(SUM(turns), 0) AS turns,
  SUM(CASE WHEN %INTERNAL% THEN 1 ELSE 0 END) AS internal`;

/** Totals of the copied range on one side (ledger or copy), for verification. */
function copyTotals(db, table, floor, cutoff) {
  const internal = table === 'usage_ledger' ? "endpoint LIKE '%:internal'" : 'is_internal = 1';
  const where = cutoff == null ? 'id <= ?' : 'id <= ? AND ts >= ?';
  const args = cutoff == null ? [floor] : [floor, cutoff];
  const row = db.prepare(`SELECT ${SUM_COLUMNS.replace('%INTERNAL%', internal)} FROM ${table} WHERE ${where}`).get(...args);
  return { ...row };
}

const sameTotals = (a, b) => Object.keys(a).every((k) => Number(a[k]) === Number(b[k]));

function failCopyAttempt(agent, floor, want, got) {
  const attempts = (Number(readMeta(agent, USAGE_ATTEMPTS_KEY)) || 0) + 1;
  // The copy is a shadow: remove what this attempt wrote and start over later.
  agent.prepare('DELETE FROM usage_calls WHERE id <= ?').run(floor);
  writeMeta(agent, USAGE_CURSOR_KEY, 0);
  writeMeta(agent, USAGE_ATTEMPTS_KEY, attempts);
  writeMeta(agent, USAGE_PENDING_KEY, '1');
  writeMeta(agent, USAGE_VERIFIED_KEY, `mismatch:${attempts}`);
  writeMeta(agent, 'usage_copy_mismatch', JSON.stringify({ want, got }));
  if (attempts >= USAGE_MAX_ATTEMPTS) writeMeta(agent, USAGE_GAVE_UP_KEY, '1');
  return { ok: false, table: 'usage_ledger', copied: 0, done: false, reason: 'verify_mismatch', attempts };
}

/** One batch of the usage backfill, in one transaction with its cursor. */
export function copyUsageStep({ mainDb = getDb(), agentDb = getAgentDb(), batch = COPY_BATCH_ROWS } = {}) {
  if (!agentDb) return { ok: false, reason: 'unavailable' };
  if (usageCopyDone({ agentDb, mainDb })) return { ok: true, table: null, copied: 0, done: true };
  if (readMeta(agentDb, USAGE_GAVE_UP_KEY)) return { ok: false, table: 'usage_ledger', reason: 'gave_up', done: false };
  if (readMeta(agentDb, USAGE_PENDING_KEY) === '1') {
    return { ok: false, table: 'usage_ledger', reason: 'verify_retry_next_boot', done: false };
  }
  const floor = Number(readMeta(agentDb, USAGE_FLOOR_KEY));
  const cutoff = readMeta(agentDb, USAGE_CUTOFF_KEY);
  if (!Number.isFinite(floor) || !cutoff) {
    // The bounds were never set (store recreated, or the boot step did not run).
    prepareUsageCopy(agentDb, mainDb, {});
    return { ok: true, table: 'usage_ledger', copied: 0, done: false };
  }
  const afterId = Number(readMeta(agentDb, USAGE_CURSOR_KEY)) || 0;
  const copied = agentDb.transaction(() => {
    const rows = mainDb.prepare(
      `SELECT id, user_id, ts, provider, model, source, endpoint, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, runs, request_id, turns, stop_reason
         FROM usage_ledger WHERE id > ? AND id <= ? AND ts >= ? ORDER BY id LIMIT ?`,
    ).all(afterId, floor, cutoff, batch);
    const ins = agentDb.prepare(
      `INSERT OR IGNORE INTO usage_calls
         (id, user_id, day, ts, provider, model, source, endpoint, is_internal,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          runs, request_id, turns, stop_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(r.id, r.user_id, String(r.ts).slice(0, 10), r.ts, r.provider, r.model, r.source ?? 'api',
        r.endpoint ?? null, isInternalEndpoint(r.endpoint), r.input_tokens ?? null, r.output_tokens ?? null,
        r.cache_read_tokens ?? null, r.cache_creation_tokens ?? null, r.runs ?? 1, r.request_id ?? null,
        r.turns ?? null, r.stop_reason ?? null);
    }
    if (rows.length) writeMeta(agentDb, USAGE_CURSOR_KEY, rows[rows.length - 1].id);
    return rows.length;
  })();
  if (copied === 0) {
    const want = copyTotals(mainDb, 'usage_ledger', floor, cutoff);
    const got = copyTotals(agentDb, 'usage_calls', floor, null);
    if (!sameTotals(want, got)) return failCopyAttempt(agentDb, floor, want, got);
    writeMeta(agentDb, USAGE_VERIFIED_KEY, 'ok');
    writeMeta(agentDb, USAGE_DONE_KEY, '1');
    return { ok: true, table: 'usage_ledger', copied: 0, done: true };
  }
  return { ok: true, table: 'usage_ledger', copied, done: false };
}

/** True once the usage backfill is finished (or the main DB has no ledger). */
export function usageCopyDone({ agentDb = getAgentDb(), mainDb = getDb() } = {}) {
  if (!agentDb) return false;
  return !hasTable(mainDb, 'usage_ledger') || Boolean(readMeta(agentDb, USAGE_DONE_KEY));
}

// Batch writers. Each takes the main rows of one batch and inserts them.
const COPY = {
  activity(agent, mainDb, afterId, limit) {
    const rows = mainDb.prepare(
      'SELECT id, user_id, kind, title, detail, link, created_at FROM activity WHERE id > ? ORDER BY id LIMIT ?',
    ).all(afterId, limit);
    const ins = agent.prepare(
      'INSERT OR IGNORE INTO activity (id, user_id, kind, title, detail, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of rows) ins.run(r.id, r.user_id, r.kind, r.title, r.detail, r.link, r.created_at);
    return rows;
  },
  turn_tool_events(agent, mainDb, afterId, limit) {
    const rows = mainDb.prepare(
      `SELECT id, user_id, turn_id, engine, mode, seq, tool, result_chars, truncated, is_error, created_at,
              COALESCE(date(created_at, 'localtime'), date('now', 'localtime')) AS day
         FROM turn_tool_events WHERE id > ? ORDER BY id LIMIT ?`,
    ).all(afterId, limit);
    const ins = agent.prepare(
      `INSERT OR IGNORE INTO agent_tool_events
         (id, user_id, run_id, day, engine, mode, seq, tool, result_chars, truncated, is_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of rows) {
      ins.run(r.id, r.user_id, r.turn_id, r.day, r.engine, r.mode, r.seq, r.tool,
        r.result_chars, r.truncated, r.is_error, r.created_at);
    }
    return rows;
  },
  turn_composition(agent, mainDb, afterId, limit, columns) {
    const cols = columns.join(', ');
    const rows = mainDb.prepare(
      `SELECT ${cols}, COALESCE(date(created_at, 'localtime'), date('now', 'localtime')) AS day
         FROM turn_composition WHERE id > ? ORDER BY id LIMIT ?`,
    ).all(afterId, limit);
    const names = [...columns, 'day'];
    const ins = agent.prepare(
      `INSERT OR IGNORE INTO turn_composition (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    );
    for (const r of rows) ins.run(...names.map((n) => r[n]));
    return rows;
  },
};

/** Columns present in both the main and the agent turn_composition (id first). */
function sharedComposition(mainDb, agent) {
  const main = mainDb.prepare('PRAGMA table_info(turn_composition)').all().map((c) => c.name);
  const mine = new Set(agent.prepare('PRAGMA table_info(turn_composition)').all().map((c) => c.name));
  return main.filter((c) => mine.has(c) && c !== 'day');
}

function copyActivitySeen(agent, mainDb) {
  if (!hasTable(mainDb, 'activity_seen')) return 0;
  const rows = mainDb.prepare('SELECT user_id, last_seen_id FROM activity_seen').all();
  const ins = agent.prepare(
    `INSERT INTO activity_seen (user_id, last_seen_id) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET last_seen_id = MAX(last_seen_id, excluded.last_seen_id)`,
  );
  for (const r of rows) ins.run(r.user_id, r.last_seen_id);
  return rows.length;
}

/**
 * One batch of one table, in one agent.db transaction with its cursor. Returns
 * { table, copied, done }. `done` means the table is finished and verified.
 */
export function copyHistoryStep({ mainDb = getDb(), agentDb = getAgentDb(), batch = COPY_BATCH_ROWS } = {}) {
  if (!agentDb) return { ok: false, reason: 'unavailable' };
  for (const table of TABLES) {
    if (!hasTable(mainDb, table)) { writeMeta(agentDb, doneKey(table), '1'); continue; }
    if (readMeta(agentDb, doneKey(table))) continue;
    const afterId = Number(readMeta(agentDb, cursorKey(table))) || 0;
    const columns = table === 'turn_composition' ? sharedComposition(mainDb, agentDb) : null;
    const copied = agentDb.transaction(() => {
      const rows = COPY[table](agentDb, mainDb, afterId, batch, columns);
      if (rows.length) writeMeta(agentDb, cursorKey(table), rows[rows.length - 1].id);
      return rows.length;
    })();
    if (copied === 0) {
      verify(agentDb, mainDb, table);
      writeMeta(agentDb, doneKey(table), '1');
    }
    return { ok: true, table, copied, done: false };
  }
  return copyUsageStep({ mainDb, agentDb, batch });
}

function verify(agent, mainDb, table) {
  const floor = Number(readMeta(agent, cursorKey(table))) || 0;
  const srcTable = table;
  const destTable = table === 'turn_tool_events' ? 'agent_tool_events' : table;
  const mainCount = mainDb.prepare(`SELECT COUNT(*) AS n FROM ${srcTable} WHERE id <= ?`).get(floor).n;
  const copyCount = agent.prepare(`SELECT COUNT(*) AS n FROM ${destTable} WHERE id <= ?`).get(floor).n;
  writeMeta(agent, verifiedKey(table), mainCount === copyCount ? 'ok' : `mismatch:${mainCount}:${copyCount}`);
}

/** True once every table is copied. */
export function historyCopyDone({ agentDb = getAgentDb(), mainDb = getDb() } = {}) {
  if (!agentDb) return false;
  return TABLES.every((t) => !hasTable(mainDb, t) || Boolean(readMeta(agentDb, doneKey(t))))
    && (!hasTable(mainDb, 'activity_seen') || Boolean(readMeta(agentDb, doneKey('activity_seen'))))
    && usageCopyDone({ agentDb, mainDb });
}

/** Run the copy to completion in one call (tests and operator tools). */
export function runHistoryCopy(opts = {}) {
  let steps = 0;
  for (;;) {
    const r = copyHistoryStep(opts);
    if (!r.ok || r.done) return { ok: r.ok, steps };
    steps += 1;
  }
}
