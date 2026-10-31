// Per-user additions to the extension install allowlist (migration 0057). Data access only.
import { getDb, requireUser } from './db.mjs';

export function getUserAllowlist(userId) {
  requireUser(userId);
  const r = getDb().prepare('SELECT sources_json FROM ext_source_allowlist WHERE user_id = ?').get(userId);
  if (!r) return [];
  try {
    const v = JSON.parse(r.sources_json);
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch { return []; }
}

export function setUserAllowlist(userId, sources) {
  requireUser(userId);
  getDb().prepare(`INSERT INTO ext_source_allowlist (user_id, sources_json) VALUES (?,?)
    ON CONFLICT(user_id) DO UPDATE SET sources_json = excluded.sources_json, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(userId, JSON.stringify(sources));
}
