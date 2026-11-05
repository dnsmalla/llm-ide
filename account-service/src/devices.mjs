import { newId } from './db.mjs';
import { HttpError } from './http.mjs';

// Sub-project 2 registers only the account's desktop (design 4.4 step 5). The relay connection and
// link requests are later sub-projects; no device token is minted here yet.
export const DESKTOP_TIER = 'desktop';

export function publicDevice(row) {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    status: row.status,
    tier: row.tier,
    createdAt: row.created_at,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function registerDesktop(db, now, { userId, label, signingKey, ecdhKey }) {
  const t = now();
  const id = newId();
  db.transaction(() => {
    const existing = db.prepare("SELECT 1 FROM devices WHERE user_id = ? AND kind = 'desktop'").get(userId);
    if (existing) throw new HttpError(409, 'desktop_exists');
    db.prepare(
      `INSERT INTO devices (id, user_id, kind, label, status, signing_key, ecdh_key, tier, created_at, updated_at, linked_at)
       VALUES (?, ?, 'desktop', ?, 'linked', ?, ?, ?, ?, ?, ?)`,
    ).run(id, userId, label, signingKey, ecdhKey, DESKTOP_TIER, t, t, t);
  })();
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(id);
}


export function listDevices(db, userId) {
  return db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY created_at').all(userId).map(publicDevice);
}

export function revokeDevice(db, now, { userId, id }) {
  const row = db.prepare('SELECT * FROM devices WHERE id = ? AND user_id = ?').get(id, userId);
  if (!row) return false;
  if (row.status === 'revoked') return true;
  db.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(now(), now(), id, userId);
  return true;
}
