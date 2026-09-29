// Per-turn tool accounting (migration 0035). Best-effort by contract: a
// telemetry write must never break a model turn.
import { getDb, requireUser } from './db.mjs';

const MAX_EVENTS_PER_TURN = 200;
const clampInt = (v) => Math.max(0, Math.min(1_000_000_000, Math.trunc(Number(v) || 0)));
const clampStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

export function recordToolEvents(userId, { turnId, engine, mode = null, events } = {}) {
  try {
    requireUser(userId);
    if (typeof turnId !== 'string' || !turnId) return 0;
    if (engine !== 'v2' && engine !== 'legacy') return 0;
    if (!Array.isArray(events) || events.length === 0) return 0;
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO turn_tool_events
         (user_id, turn_id, engine, mode, seq, tool, result_chars, truncated, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let written = 0;
    db.transaction(() => {
      events.slice(0, MAX_EVENTS_PER_TURN).forEach((e, seq) => {
        const tool = clampStr(e?.tool, 128);
        if (!tool) return;
        insert.run(userId, clampStr(turnId, 128), engine, clampStr(mode, 32), seq, tool,
          clampInt(e.resultChars), e.truncated ? 1 : 0, e.isError ? 1 : 0);
        written += 1;
      });
    })();
    return written;
  } catch {
    return 0;
  }
}

/**
 * Core query implementation that uses a provided db handle.
 * userId null = every user (operator report only).
 */
export function summarizeToolEventsOn(db, userId, { days = 7 } = {}) {
  if (userId !== null) requireUser(userId);
  const since = `-${Math.max(1, Math.min(365, Math.trunc(Number(days) || 7)))} days`;
  const userSql = userId === null ? '' : ' AND user_id = ?';
  const binds = userId === null ? [since] : [since, userId];
  const window = `created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)${userSql}`;

  const turnIds = db.prepare(
    `SELECT DISTINCT turn_id FROM turn_tool_events WHERE ${window}`,
  ).all(...binds).map((r) => r.turn_id);

  const byTool = db.prepare(
    `SELECT tool, COUNT(*) AS calls, CAST(ROUND(AVG(result_chars)) AS INTEGER) AS avgChars
     FROM turn_tool_events WHERE ${window} GROUP BY tool ORDER BY calls DESC`,
  ).all(...binds);

  // Per turn: did find-code run, and did it run before the first Read/Grep/Glob?
  const perTurn = db.prepare(
    `SELECT turn_id,
            MIN(CASE WHEN tool = 'find-code' THEN seq END) AS fc,
            MIN(CASE WHEN tool IN ('Read','Grep','Glob') THEN seq END) AS native
     FROM turn_tool_events WHERE ${window} GROUP BY turn_id`,
  ).all(...binds);
  const withFc = perTurn.filter((t) => t.fc !== null).map((t) => t.turn_id);
  const withoutFc = perTurn.filter((t) => t.fc === null).map((t) => t.turn_id);
  const fcFirst = perTurn.filter((t) => t.fc !== null && (t.native === null || t.fc < t.native)).length;

  const tokenAvg = (ids) => {
    if (ids.length === 0) return null;
    const place = ids.map(() => '?').join(',');
    // Sum a turn's ledger rows first (a turn can meter several models), then
    // average across turns.
    const row = db.prepare(
      `SELECT COUNT(*) AS turns, AVG(i) AS input, AVG(cr) AS cacheRead,
              AVG(cc) AS cacheCreation, AVG(o) AS output
       FROM (SELECT request_id,
                    SUM(COALESCE(input_tokens,0)) AS i, SUM(COALESCE(cache_read_tokens,0)) AS cr,
                    SUM(COALESCE(cache_creation_tokens,0)) AS cc, SUM(COALESCE(output_tokens,0)) AS o
             FROM usage_ledger WHERE request_id IN (${place}) GROUP BY request_id)`,
    ).get(...ids);
    if (!row || !row.turns) return null;
    const r = (v) => Math.round(v || 0);
    return { turns: row.turns, input: r(row.input), cacheRead: r(row.cacheRead),
      cacheCreation: r(row.cacheCreation), output: r(row.output) };
  };

  return {
    turns: turnIds.length,
    turnsWithFindCode: withFc.length,
    findCodeFirstTurns: fcFirst,
    byTool,
    tokensWithFindCode: tokenAvg(withFc),
    tokensWithoutFindCode: tokenAvg(withoutFc),
  };
}

/**
 * Wrapper that fetches the DB connection, calls summarizeToolEventsOn,
 * and returns the result. Signature and behaviour must not change (Task 1 tests).
 */
export function summarizeToolEvents(userId, { days = 7 } = {}) {
  return summarizeToolEventsOn(getDb(), userId, { days });
}
