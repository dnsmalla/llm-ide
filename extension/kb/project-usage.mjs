// Per-project monthly spend (ADR 0021 H1.3). The member cap stays monthly; a project grant may add a
// tighter cap, and it is summed from the ledger rows that named that project. Rows written before
// migration 0070, or turns with no project in scope, have `project_id` NULL and never count here.
//
// A ledger read error fails CLOSED (Infinity), exactly like `usedUsdMonth`: an unknown project spend
// must not silently lift a cap.
import { toSqliteLocal, windowStart } from './usage.mjs';

/** The project's USD spend this month, from `usage_ledger.project_id`. */
export function usedUsdMonthForProject(db, userId, projectId, now = new Date()) {
  if (!userId || !projectId) return 0;
  try {
    const start = toSqliteLocal(windowStart('monthly', now));
    const row = db.prepare(
      'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM usage_ledger WHERE user_id = ? AND project_id = ? AND ts >= ?',
    ).get(String(userId), String(projectId), start);
    const n = Number(row?.usd);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return Number.POSITIVE_INFINITY; // unknown project spend: assume the cap is reached (fail closed)
  }
}

/**
 * The spend a project-scoped cap check should compare: the project's own month when a project cap is
 * in force, the member's whole month otherwise. `cap` 0 = no cap. Pure decision, injected readers.
 */
export function projectCapSpend({ cap, projectUsed, memberUsed }) {
  const n = Number(cap);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number.isFinite(projectUsed) ? projectUsed : memberUsed;
}
