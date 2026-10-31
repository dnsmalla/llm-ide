// Per-user iCal feed sources (non-secret metadata). The feed URL is a bearer secret and lives ONLY in the vault
// (server/vault.mjs, key ical.src.<sourceId>.url); the sync cursor and health live in connector_sync_state with
// connector_id 'ical' and account_id = the source id (kb/google-store.mjs getSyncState / patchSyncState).
// Every function takes userId first and scopes by it.
import { getDb, requireUser } from './db.mjs';

export const MAX_ICAL_SOURCES = 10;
export const SOURCE_ID_RE = /^[a-f0-9]{12}$/;

const row = (r) => ({ sourceId: r.source_id, name: r.name, idPrefix: r.id_prefix, host: r.host, createdAt: r.created_at });

export function addIcalSource(userId, { sourceId, name, idPrefix, host }) {
  requireUser(userId);
  if (!SOURCE_ID_RE.test(String(sourceId))) throw new Error('invalid source id');
  getDb().prepare('INSERT INTO ical_sources (user_id, source_id, name, id_prefix, host) VALUES (?, ?, ?, ?, ?)')
    .run(userId, sourceId, String(name || ''), String(idPrefix || ''), String(host || ''));
}

export function getIcalSource(userId, sourceId) {
  requireUser(userId);
  const r = getDb().prepare('SELECT * FROM ical_sources WHERE user_id = ? AND source_id = ?').get(userId, String(sourceId));
  return r ? row(r) : null;
}

export function listIcalSources(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT * FROM ical_sources WHERE user_id = ? ORDER BY created_at, source_id').all(userId).map(row);
}

export function countIcalSources(userId) {
  requireUser(userId);
  return getDb().prepare('SELECT COUNT(*) AS n FROM ical_sources WHERE user_id = ?').get(userId).n;
}

/** Removes the source row and its sync state (the vault URL and the cached `sources` rows are removed by the caller). */
export function deleteIcalSource(userId, sourceId) {
  requireUser(userId);
  const db = getDb();
  return db.transaction(() => {
    const s = db.prepare("DELETE FROM connector_sync_state WHERE user_id = ? AND connector_id = 'ical' AND account_id = ?").run(userId, String(sourceId)).changes;
    const a = db.prepare('DELETE FROM ical_sources WHERE user_id = ? AND source_id = ?').run(userId, String(sourceId)).changes;
    return { sources: a, syncStates: s };
  })();
}
