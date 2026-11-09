// Per-project monthly spend (ADR 0021 H1.3). The member cap stays monthly; a project grant may add a
// tighter cap, and it is summed from the ledger rows that named that project. Rows written before
// migration 0070, or turns with no project in scope, have `project_id` NULL and never count here.
//
// A ledger read error fails CLOSED (Infinity), exactly like `usedUsdMonth`: an unknown project spend
// must not silently lift a cap.
import { toSqliteLocal, windowStart } from './usage.mjs';
import { getProjectMember } from './projects.mjs';

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
 * What is left of the caller's cap on ONE project this month, or null when that project has no cap
 * (no row, or `usd_cap_month = 0`). R-034 #6: the turn budget takes the minimum of this, the member's
 * month and the per-model cap, so a project cap of 5 USD bounds a run even when the member has 100 left.
 * A read failure answers 0 (fail closed).
 */
export function remainingMonthlyUsdForProject(db, userId, projectId, now = new Date()) {
  if (!userId || !projectId) return null;
  try {
    const cap = Number(getProjectMember(db, userId, projectId)?.usdCapMonth);
    if (!Number.isFinite(cap) || cap <= 0) return null;
    return Math.max(0, cap - usedUsdMonthForProject(db, userId, projectId, now));
  } catch {
    return 0;
  }
}

