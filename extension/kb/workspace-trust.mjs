// Per-user workspace trust records (migration 0056). Data access only: every helper takes userId first.
// A path is stored as its realpath. No row = untrusted. Trust is only ever set by an explicit user request
// (PUT /auth/me/workspace-trust); no code path here or elsewhere trusts a folder on its own.
import fs from 'node:fs';
import { getDb, requireUser } from './db.mjs';

export const MAX_TRUST_ROWS = 500;

/** The realpath of an existing folder, or null (missing, not a directory, unreadable). */
export function realFolder(p) {
  if (typeof p !== 'string' || !p) return null;
  try {
    const real = fs.realpathSync(p);
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

export function listWorkspaceTrust(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT path, trusted, updated_at FROM workspace_trust WHERE user_id = ? ORDER BY path')
    .all(userId).map((r) => ({ path: r.path, trusted: r.trusted === 1, updatedAt: r.updated_at }));
}

/** @returns {boolean} true only when the user explicitly trusted this exact real path. */
export function isWorkspaceTrusted(userId, realPath) {
  requireUser(userId);
  if (typeof realPath !== 'string' || !realPath) return false;
  const r = getDb().prepare('SELECT trusted FROM workspace_trust WHERE user_id = ? AND path = ?').get(userId, realPath);
  return r?.trusted === 1;
}

/** @returns {{ path: string, trusted: boolean, updatedAt: string } | { error: 'too_many' }} */
export function setWorkspaceTrust(userId, realPath, trusted) {
  requireUser(userId);
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM workspace_trust WHERE user_id = ? AND path = ?').get(userId, realPath);
  if (!exists) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM workspace_trust WHERE user_id = ?').get(userId).n;
    if (n >= MAX_TRUST_ROWS) return { error: 'too_many' };
  }
  db.prepare(`INSERT INTO workspace_trust (user_id, path, trusted) VALUES (?,?,?)
    ON CONFLICT(user_id, path) DO UPDATE SET trusted = excluded.trusted, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(userId, realPath, trusted ? 1 : 0);
  const r = db.prepare('SELECT path, trusted, updated_at FROM workspace_trust WHERE user_id = ? AND path = ?').get(userId, realPath);
  return { path: r.path, trusted: r.trusted === 1, updatedAt: r.updated_at };
}
