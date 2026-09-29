// Pure read-side summary of turn_tool_events. Imports NOTHING internal on
// purpose: the read-only report script loads this, and importing kb/db.mjs
// would pull in core/logger.mjs, whose module-load log rotation would rename
// the live server's log.

/**
 * Core query implementation that uses a provided db handle.
 * userId null = every user (operator report only). engine defaults to 'v2'
 * (legacy turns never have ledger rows); engine null = all engines.
 */
export function summarizeToolEventsOn(db, userId, { days = 7, engine = 'v2' } = {}) {
  if (userId !== null && (typeof userId !== 'string' || !userId)) throw new Error('userId is required');
  const since = `-${Math.max(1, Math.min(365, Math.trunc(Number(days) || 7)))} days`;
  const userSql = userId === null ? '' : ' AND user_id = ?';
  const engineSql = engine === null ? '' : ' AND engine = ?';
  const binds = [since, ...(userId === null ? [] : [userId]), ...(engine === null ? [] : [engine])];
  const window = `created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)${userSql}${engineSql}`;

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
  const fcFirst = perTurn.filter((t) => t.fc !== null && (t.native === null || t.fc < t.native)).length;
  const withFcCount = perTurn.filter((t) => t.fc !== null).length;

  // Sum a turn's ledger rows first (a turn can meter several models), then
  // average across turns. The turn set is a subquery over the same window,
  // so there is no bound parameter per turn id.
  const tokenAvg = (hasFindCode) => {
    const ledgerUser = userId === null ? '' : ' AND user_id = ?';
    const row = db.prepare(
      `SELECT COUNT(*) AS turns, AVG(i) AS input, AVG(cr) AS cacheRead,
              AVG(cc) AS cacheCreation, AVG(o) AS output
       FROM (SELECT request_id,
                    SUM(COALESCE(input_tokens,0)) AS i, SUM(COALESCE(cache_read_tokens,0)) AS cr,
                    SUM(COALESCE(cache_creation_tokens,0)) AS cc, SUM(COALESCE(output_tokens,0)) AS o
             FROM usage_ledger
             WHERE request_id IN (
               SELECT turn_id FROM turn_tool_events WHERE ${window}
               GROUP BY turn_id
               HAVING ${hasFindCode ? '' : 'NOT '}SUM(tool = 'find-code') > 0
             )${ledgerUser}
             GROUP BY request_id)`,
    ).get(...binds, ...(userId === null ? [] : [userId]));
    if (!row || !row.turns) return null;
    const r = (v) => Math.round(v || 0);
    return { turns: row.turns, input: r(row.input), cacheRead: r(row.cacheRead),
      cacheCreation: r(row.cacheCreation), output: r(row.output) };
  };

  return {
    turns: turnIds.length,
    turnsWithFindCode: withFcCount,
    findCodeFirstTurns: fcFirst,
    byTool,
    tokensWithFindCode: tokenAvg(true),
    tokensWithoutFindCode: tokenAvg(false),
  };
}
