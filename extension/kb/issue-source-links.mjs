// The durable Sources -> Issue record (migration 0077). Every helper takes `userId` first, as the other kb helpers do.
import { getDb } from './db.mjs';

/** The issue already filed for this action, or null. */
export function findIssueLink(userId, { provider, repo, sourceRef, textHash }) {
  return getDb().prepare(
    'SELECT issue_number AS issueNumber, issue_url AS issueUrl FROM issue_source_links WHERE user_id = ? AND provider = ? AND repo = ? AND source_ref = ? AND text_hash = ?',
  ).get(userId, provider, repo, sourceRef, textHash) ?? null;
}

/** Records a filed action. A repeat of the same key keeps the first row. */
export function recordIssueLink(userId, { provider, repo, sourceRef, textHash, issueNumber = null, issueUrl = null }) {
  getDb().prepare(
    'INSERT OR IGNORE INTO issue_source_links (user_id, provider, repo, source_ref, text_hash, issue_number, issue_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(userId, provider, repo, sourceRef, textHash, issueNumber, issueUrl);
}
