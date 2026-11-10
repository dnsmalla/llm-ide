// The durable Sources -> Issue record (migration 0077). Every helper takes `userId` first, as the other kb helpers do.
// Timestamps are ISO strings written by the caller, so a pending claim's age compares as text.
import { getDb } from './db.mjs';

const WHERE = 'user_id = ? AND provider = ? AND repo = ? AND source_ref = ? AND text_hash = ?';
const args = (userId, k) => [userId, k.provider, k.repo, k.sourceRef, k.textHash];

/** The row for this action: { status: 'pending' | 'filed', createdAt, issueNumber, issueUrl }, or null. */
export function findIssueLink(userId, k) {
  return getDb().prepare(
    `SELECT status, created_at AS createdAt, issue_number AS issueNumber, issue_url AS issueUrl FROM issue_source_links WHERE ${WHERE}`,
  ).get(...args(userId, k)) ?? null;
}

/**
 * Takes the right to file the action now. 'claimed': a new pending row, or an old pending row this run now owns.
 * 'filed': already on the board. 'inflight': a pending row younger than `staleBefore`, another run's claim.
 */
export function claimIssueLink(userId, k, { now, staleBefore }) {
  const db = getDb();
  const row = findIssueLink(userId, k);
  if (!row) {
    const r = db.prepare(
      "INSERT OR IGNORE INTO issue_source_links (user_id, provider, repo, source_ref, text_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    ).run(...args(userId, k), now);
    return r.changes ? 'claimed' : 'inflight';
  }
  if (row.status === 'filed') return 'filed';
  if (row.createdAt > staleBefore) return 'inflight';
  const r = db.prepare(`UPDATE issue_source_links SET created_at = ? WHERE ${WHERE} AND status = 'pending' AND created_at = ?`)
    .run(now, ...args(userId, k), row.createdAt);
  return r.changes ? 'claimed' : 'inflight';
}

/** The provider created the issue: the pending claim becomes the filed record. */
export function completeIssueLink(userId, k, { issueNumber = null, issueUrl = null }) {
  getDb().prepare(`UPDATE issue_source_links SET status = 'filed', issue_number = ?, issue_url = ? WHERE ${WHERE}`)
    .run(issueNumber, issueUrl, ...args(userId, k));
}

/** The provider refused the create: the claim is dropped, so the next run files the action. */
export function releaseIssueLink(userId, k) {
  getDb().prepare(`DELETE FROM issue_source_links WHERE ${WHERE} AND status = 'pending'`).run(...args(userId, k));
}
