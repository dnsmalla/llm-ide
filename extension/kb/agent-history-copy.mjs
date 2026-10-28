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
  return floors;
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
      if (table === 'activity' && hasTable(mainDb, 'activity_seen')) copyActivitySeen(agentDb, mainDb);
      verify(agentDb, mainDb, table);
      writeMeta(agentDb, doneKey(table), '1');
    }
    return { ok: true, table, copied, done: false };
  }
  return { ok: true, table: null, copied: 0, done: true };
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
  return TABLES.every((t) => !hasTable(mainDb, t) || Boolean(readMeta(agentDb, doneKey(t))));
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
