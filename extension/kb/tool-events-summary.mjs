// Pure read-side summary of agent_tool_events (agent.db). Imports NOTHING
// internal on purpose: the read-only report script loads this, and importing
// kb/db.mjs would pull in core/logger.mjs, whose module-load log rotation would
// rename the live server's log.
//
// `db` is the agent.db handle. The per-turn token averages read usage_ledger,
// which stays in the MAIN DB, so the main handle goes in `ledgerDb` (two
// handles, no ATTACH). Without it the token averages are null.

/**
 * userId null = every user (operator report only). engine defaults to 'v2'
 * (legacy turns never have ledger rows); engine null = all engines.
 */
export function summarizeToolEventsOn(db, userId, { days = 7, engine = 'v2', ledgerDb = null } = {}) {
  if (userId !== null && (typeof userId !== 'string' || !userId)) throw new Error('userId is required');
  const since = `-${Math.max(1, Math.min(365, Math.trunc(Number(days) || 7)))} days`;
  const userSql = userId === null ? '' : ' AND user_id = ?';
  const engineSql = engine === null ? '' : ' AND engine = ?';
  const binds = [since, ...(userId === null ? [] : [userId]), ...(engine === null ? [] : [engine])];
  const window = `created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)${userSql}${engineSql}`;

  const turnIds = db.prepare(
    `SELECT DISTINCT run_id FROM agent_tool_events WHERE ${window}`,
  ).all(...binds).map((r) => r.run_id);

  const byTool = db.prepare(
    `SELECT tool, COUNT(*) AS calls, CAST(ROUND(AVG(result_chars)) AS INTEGER) AS avgChars
     FROM agent_tool_events WHERE ${window} GROUP BY tool ORDER BY calls DESC`,
  ).all(...binds);

  // Per turn: did find-code run, and did it run before the first Read/Grep/Glob?
  const perTurn = db.prepare(
    `SELECT run_id,
            MIN(CASE WHEN tool = 'find-code' THEN seq END) AS fc,
            MIN(CASE WHEN tool IN ('Read','Grep','Glob') THEN seq END) AS native
     FROM agent_tool_events WHERE ${window} GROUP BY run_id`,
  ).all(...binds);
  const fcFirst = perTurn.filter((t) => t.fc !== null && (t.native === null || t.fc < t.native)).length;
  const withFcCount = perTurn.filter((t) => t.fc !== null).length;

  // Sum a turn's ledger rows first (a turn can meter several models), then
  // average across turns. The turn set comes from agent.db, so the ledger
  // side is a second query with the ids inlined from that set.
  const tokenAvg = (hasFindCode) => {
    if (!ledgerDb) return null;
    const ids = perTurn.filter((t) => (t.fc !== null) === hasFindCode).map((t) => t.run_id);
    if (ids.length === 0) return null;
    const ledgerUser = userId === null ? '' : ' AND user_id = ?';
    // Chunked: one IN list per 500 ids, so a large window never hits SQLite's
    // bound-parameter limit. Per-turn sums are collected, then averaged.
    const perLedgerTurn = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = ledgerDb.prepare(
        `SELECT request_id,
                SUM(COALESCE(input_tokens,0)) AS i, SUM(COALESCE(cache_read_tokens,0)) AS cr,
                SUM(COALESCE(cache_creation_tokens,0)) AS cc, SUM(COALESCE(output_tokens,0)) AS o
           FROM usage_ledger
          WHERE request_id IN (${placeholders})${ledgerUser}
          GROUP BY request_id`,
      ).all(...chunk, ...(userId === null ? [] : [userId]));
      perLedgerTurn.push(...rows);
    }
    if (perLedgerTurn.length === 0) return null;
    const n = perLedgerTurn.length;
    const mean = (k) => perLedgerTurn.reduce((a, r) => a + (r[k] || 0), 0) / n;
    const r = (v) => Math.round(v || 0);
    return { turns: n, input: r(mean('i')), cacheRead: r(mean('cr')),
      cacheCreation: r(mean('cc')), output: r(mean('o')) };
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
