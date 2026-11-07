// Self-Heal incident store (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md; table self_heal_incidents,
// migration 0067), the Mac's IncidentStore. One row per user and signature:
//   - a repeat bumps count and lastSeen;
//   - a fixed incident that recurs reopens as new with attempts + 1;
//   - at most INCIDENT_CAP rows are kept per user (the least recently seen that is not fixing or proposed goes first).
// cleanIncident redacts the text before anything is stored. Plan A writes only new and ignored. Plan B drives the
// other statuses and the proposal columns. Nothing here logs incident text.
import { getDb, requireUser } from './db.mjs';
import { cleanIncident } from '../core/incident.mjs';

export const INCIDENT_CAP = 200;
const BUSY = "('fixing', 'proposed')";

const toIncident = (r) => ({
  id: r.id,
  source: r.source,
  category: r.category,
  message: r.message,
  stack: r.stack,
  environmental: r.environmental,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  count: r.count,
  attempts: r.attempts,
  status: r.status,
  note: r.note,
  proposal: r.proposal_worktree
    ? { mainRepo: r.proposal_main_repo, worktreePath: r.proposal_worktree, branch: r.proposal_branch, baseCommit: r.proposal_base_commit }
    : null,
});

/** Records one report (redacted, signed). Returns the stored incident, or null when the report is unusable. */
export function recordIncident(userId, report, now = Date.now()) {
  requireUser(userId);
  const c = cleanIncident(report);
  if (!c) return null;
  const db = getDb();
  return db.transaction(() => {
    const prev = db.prepare('SELECT status FROM self_heal_incidents WHERE user_id = ? AND id = ?').get(userId, c.id);
    if (prev) {
      db.prepare(`UPDATE self_heal_incidents SET count = count + 1, last_seen = MAX(last_seen, ?), message = ?,
          stack = COALESCE(?, stack), environmental = ? WHERE user_id = ? AND id = ?`)
        .run(now, c.message, c.stack, c.environmental, userId, c.id);
      if (prev.status === 'fixed') {
        db.prepare(`UPDATE self_heal_incidents SET status = 'new', attempts = attempts + 1, proposal_main_repo = NULL,
            proposal_worktree = NULL, proposal_branch = NULL, proposal_base_commit = NULL WHERE user_id = ? AND id = ?`)
          .run(userId, c.id);
      }
    } else {
      db.prepare(`INSERT INTO self_heal_incidents (user_id, id, source, category, message, stack, environmental, first_seen, last_seen)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, c.id, c.source, c.category, c.message, c.stack, c.environmental, now, now);
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM self_heal_incidents WHERE user_id = ?').get(userId);
      if (n > INCIDENT_CAP) {
        db.prepare(`DELETE FROM self_heal_incidents WHERE user_id = ? AND id IN (
            SELECT id FROM self_heal_incidents WHERE user_id = ? AND id != ? AND status NOT IN ${BUSY}
            ORDER BY last_seen ASC, first_seen ASC LIMIT ?)`)
          .run(userId, userId, c.id, n - INCIDENT_CAP);
      }
    }
    return toIncident(db.prepare('SELECT * FROM self_heal_incidents WHERE user_id = ? AND id = ?').get(userId, c.id));
  })();
}

/** The user's incidents, most recently seen first. */
export function listIncidents(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM self_heal_incidents WHERE user_id = ? ORDER BY last_seen DESC, id')
    .all(userId).map(toIncident);
}

/** Marks one incident ignored. False when it is not the user's, unknown, or held by a fix run (fixing / proposed). */
export function ignoreIncident(userId, id) {
  requireUser(userId);
  return getDb().prepare(`UPDATE self_heal_incidents SET status = 'ignored' WHERE user_id = ? AND id = ? AND status NOT IN ${BUSY}`)
    .run(userId, String(id)).changes > 0;
}

/** Deletes the user's incidents except the ones a fix run holds. Returns how many were deleted. */
export function clearIncidents(userId) {
  requireUser(userId);
  return getDb().prepare(`DELETE FROM self_heal_incidents WHERE user_id = ? AND status NOT IN ${BUSY}`).run(userId).changes;
}

/**
 * Boot maintenance, install-wide like purgeExpiredJti. A `fixing` incident with no run holding it was left by a core
 * that quit or crashed mid-run. Nothing will ever answer it, so it goes back to `new` (the Mac's IncidentStore.load).
 */
export function reopenOrphanedIncidents() {
  return getDb().prepare("UPDATE self_heal_incidents SET status = 'new' WHERE status = 'fixing'").run().changes;
}
