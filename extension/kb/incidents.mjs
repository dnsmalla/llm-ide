// Self-Heal incident store (docs/superpowers/plans/2026-11-07-self-heal-a-incidents.md; table self_heal_incidents,
// migration 0067), the Mac's IncidentStore. One row per user and signature:
//   - a repeat bumps count and lastSeen;
//   - a fixed incident that recurs reopens as new with attempts + 1;
//   - at most INCIDENT_CAP rows are kept per user (the least recently seen that is not fixing or proposed goes first).
// cleanIncident redacts the text before anything is stored. Plan A writes new and ignored; plan B's helpers at the end
// drive fixing, proposed, needsHuman, fixed, attempts and the proposal columns. Nothing here logs incident text.
import { getDb, requireUser } from './db.mjs';
import { cleanIncident } from '../core/incident.mjs';
import { MAX_ATTEMPTS } from '../core/self-heal-batch.mjs';

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

/**
 * Plan B triage (the Mac's SelfHealBatch.select): up to `max` `new` incidents, most frequent first. An environmental
 * one met on the way is ignored with its reason so it never returns to triage; a picked one moves to `fixing`, so no
 * second run can pick it. One transaction.
 */
export function triageIncidents(userId, max) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const rows = db.prepare("SELECT * FROM self_heal_incidents WHERE user_id = ? AND status = 'new' ORDER BY count DESC, last_seen DESC, id")
      .all(userId);
    const ignore = db.prepare("UPDATE self_heal_incidents SET status = 'ignored', note = ? WHERE user_id = ? AND id = ?");
    const fix = db.prepare("UPDATE self_heal_incidents SET status = 'fixing' WHERE user_id = ? AND id = ?");
    const picked = [];
    for (const r of rows) {
      if (picked.length >= max) break;
      if (r.environmental) {
        ignore.run(`environment: ${r.environmental}`, userId, r.id);
        continue;
      }
      fix.run(userId, r.id);
      picked.push(toIncident({ ...r, status: 'fixing' }));
    }
    return picked;
  })();
}

/** A run that ended without an outcome (its lease ran out): its `fixing` incidents go back to `new`. */
export function reopenIncidents(userId, ids) {
  requireUser(userId);
  const db = getDb();
  const stmt = db.prepare("UPDATE self_heal_incidents SET status = 'new' WHERE user_id = ? AND id = ? AND status = 'fixing'");
  return db.transaction(() => ids.reduce((n, id) => n + stmt.run(userId, String(id)).changes, 0))();
}

/**
 * A finished run's verdicts onto its incidents (the Mac's SelfHealOutcome.apply):
 *   - `fixed` on a run that succeeded (verify passed, the worktree has a diff, `proposal` given) → `proposed`;
 *   - `environmental` → `ignored`;
 *   - the agent was down or the run aborted → back to `new`, nothing else changes;
 *   - anything else is a failed attempt: attempts + 1, `needsHuman` at MAX_ATTEMPTS.
 * Rows no longer `fixing` (cleared, reopened) are left alone. Returns how many were proposed.
 */
export function applyRunOutcome(userId, ids, results, { runSucceeded, agentDown, aborted }, proposal) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const get = db.prepare('SELECT status, attempts FROM self_heal_incidents WHERE user_id = ? AND id = ?');
    const propose = db.prepare(`UPDATE self_heal_incidents SET status = 'proposed', note = ?, proposal_main_repo = ?,
        proposal_worktree = ?, proposal_branch = ?, proposal_base_commit = ? WHERE user_id = ? AND id = ?`);
    const setStatus = db.prepare('UPDATE self_heal_incidents SET status = ?, note = ? WHERE user_id = ? AND id = ?');
    const reopen = db.prepare("UPDATE self_heal_incidents SET status = 'new' WHERE user_id = ? AND id = ?");
    const failed = db.prepare('UPDATE self_heal_incidents SET attempts = ?, status = ?, note = ? WHERE user_id = ? AND id = ?');
    let proposed = 0;
    for (const id of ids) {
      const row = get.get(userId, id);
      if (!row || row.status !== 'fixing') continue;
      const r = results.get(id);
      if (r?.verdict === 'fixed' && runSucceeded && proposal) {
        propose.run(r.reason || null, proposal.mainRepo, proposal.worktreePath, proposal.branch, proposal.baseCommit, userId, id);
        proposed += 1;
      } else if (r?.verdict === 'environmental') {
        setStatus.run('ignored', `environment: ${r.reason}`, userId, id);
      } else if (agentDown || aborted) {
        reopen.run(userId, id);
      } else {
        const attempts = row.attempts + 1;
        failed.run(attempts, attempts >= MAX_ATTEMPTS ? 'needsHuman' : 'new', r?.reason || null, userId, id);
      }
    }
    return proposed;
  })();
}

/** The user applied (→ `fixed`) or discarded (→ `ignored`) the proposal on `branch`. Returns the rows changed. */
export function resolveProposal(userId, branch, applied) {
  requireUser(userId);
  return getDb().prepare(`UPDATE self_heal_incidents SET status = ?, note = COALESCE(?, note), proposal_main_repo = NULL,
      proposal_worktree = NULL, proposal_branch = NULL, proposal_base_commit = NULL
      WHERE user_id = ? AND status = 'proposed' AND proposal_branch = ?`)
    .run(applied ? 'fixed' : 'ignored', applied ? null : 'proposal discarded', userId, String(branch)).changes;
}
