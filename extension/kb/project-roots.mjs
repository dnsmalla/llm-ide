// Per-user project id -> project folder registry for the docs-kit routes.
//
// There was no server-side way to map a project id to a folder before K1: the
// export route takes an id and never resolves it, and install-skills takes a
// raw client path. The design (docs-kit §7 decision 3) is that clients address
// a project by id. The Mac registers `{ id, root }` once per open, and the
// server validates the root (kb/doc-project-files.mjs `validateProjectRoot`)
// before storing it. Every lookup re-validates, so a folder that was moved,
// replaced by a symlink, or stripped of its project marker fails closed.
//
// The table is `doc_project_roots` (migration 0048), keyed by (user_id,
// project_id). The docs routes are the only readers.

import { getDb, requireUser } from './db.mjs';
import { DocFilesError, validateProjectRoot } from './doc-project-files.mjs';

/** Same shape the export route accepts (`SAFE_ID` in routes/router.mjs). */
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Store `{ id, root }` for `userId`. Validates the root first; a rejected root
 * stores nothing. Re-registering an id replaces its root.
 * @returns {{ id: string, root: string }} the id and the validated realpath
 */
export function registerProjectRoot(userId, { id, root } = {}) {
  requireUser(userId);
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) {
    throw new DocFilesError('INVALID_PROJECT_ID', 'project id must be 1 to 128 letters, digits, _ or -');
  }
  const real = validateProjectRoot(root);
  getDb().prepare(`
    INSERT INTO doc_project_roots (user_id, project_id, root, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, project_id) DO UPDATE SET
      root = excluded.root, updated_at = excluded.updated_at
  `).run(userId, id, real);
  return { id, root: real };
}

/**
 * The validated realpath of a registered project, for `userId`.
 * Throws PROJECT_NOT_REGISTERED when the id is unknown to this user (another
 * user's id is simply unknown), and re-runs the root checks on the stored path.
 */
export function resolveProjectRoot(userId, projectId) {
  requireUser(userId);
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) {
    throw new DocFilesError('INVALID_PROJECT_ID', 'project id must be 1 to 128 letters, digits, _ or -');
  }
  const row = getDb().prepare(
    'SELECT root FROM doc_project_roots WHERE user_id = ? AND project_id = ?',
  ).get(userId, projectId);
  if (!row) {
    throw new DocFilesError('PROJECT_NOT_REGISTERED', 'project is not registered on this server; the client must register it first');
  }
  return validateProjectRoot(row.root);
}
