import { newId } from './db.mjs';

export const CEREMONY_TTL_MS = 5 * 60_000;

export function createCeremonies(db, now) {
  const insert = db.prepare('INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?, ?)');
  const take = db.prepare('DELETE FROM webauthn_challenges WHERE id = ? AND purpose = ? RETURNING challenge, user_id, expires_at');
  return {
    save(purpose, challenge, userId = null) {
      const id = newId();
      insert.run(id, challenge, purpose, userId, now() + CEREMONY_TTL_MS);
      return id;
    },
    take(id, purpose) {
      if (typeof id !== 'string' || id.length > 64) return null;
      const row = take.get(id, purpose); // deleted on first use, valid or not
      return row && row.expires_at > now() ? row : null;
    },
  };
}
