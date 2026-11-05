import { createHash, randomBytes } from 'node:crypto';

export const EMAIL_TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function createEmailTokens(db, now) {
  const insert = db.prepare(
    'INSERT INTO email_tokens (token_hash, purpose, email, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const byHash = db.prepare('SELECT * FROM email_tokens WHERE token_hash = ?');
  const useAll = db.prepare('UPDATE email_tokens SET used_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL');

  return {
    issue(purpose, email, payload = {}) {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      insert.run(hash(token), purpose, email, JSON.stringify(payload), t + EMAIL_TOKEN_TTL_MS, t);
      return token;
    },
    consume(purpose, token) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
      return db.transaction(() => {
        const row = byHash.get(hash(token));
        const t = now();
        if (!row || row.purpose !== purpose || row.used_at !== null || row.expires_at <= t) return null;
        useAll.run(t, row.email, row.purpose); // this token and every older one for the address
        return { email: row.email, payload: JSON.parse(row.payload) };
      })();
    },
  };
}
