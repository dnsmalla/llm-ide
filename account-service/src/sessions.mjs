import { createHash, randomBytes } from 'node:crypto';
import { HttpError } from './http.mjs';

export const FULL_IDLE_MS = 60 * 60_000;
export const FULL_ABSOLUTE_MS = 12 * 60 * 60_000;
export const SETUP_ABSOLUTE_MS = 15 * 60_000;
export const FRESH_MS = 5 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const hash = (token) => createHash('sha256').update(token).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createSessions(db, config, now) {
  const name = config.secureCookies ? '__Host-llmide_session' : 'llmide_session';
  const attrs = `Path=/; HttpOnly; SameSite=Strict${config.secureCookies ? '; Secure' : ''}`;
  const insert = db.prepare(
    `INSERT INTO sessions (id_hash, user_id, scope, via, created_at, last_seen_at, expires_at, auth_at, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byHash = db.prepare('SELECT * FROM sessions WHERE id_hash = ?');
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?');
  const revokeOne = db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL');
  const revokeUser = db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id_hash != ? AND revoked_at IS NULL');
  const revokeUserSetup = db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND scope = 'setup' AND revoked_at IS NULL");
  const live = db.prepare('SELECT 1 FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1');

  function read(req) {
    const token = parseCookies(req.headers.cookie)[name];
    if (!token || !TOKEN_RE.test(token)) return null;
    const session = byHash.get(hash(token));
    const t = now();
    if (!session || session.revoked_at !== null || session.expires_at <= t) return null;
    if (session.scope === 'full' && t - session.last_seen_at > FULL_IDLE_MS) return null;
    touch.run(t, session.id_hash);
    return session;
  }

  return {
    cookieName: name,
    create({ userId, scope, via, ip }) {
      const token = randomBytes(32).toString('base64url');
      const t = now();
      const ttl = scope === 'full' ? FULL_ABSOLUTE_MS : SETUP_ABSOLUTE_MS;
      const idHash = hash(token);
      insert.run(idHash, userId, scope, via, t, t, t + ttl, t, ip ?? null);
      return { idHash, cookie: `${name}=${token}; ${attrs}; Max-Age=${ttl / 1000}` };
    },
    clearCookie: () => `${name}=; ${attrs}; Max-Age=0`,
    read,
    require(req, scopes = ['full']) {
      const session = read(req);
      if (!session || !scopes.includes(session.scope)) throw new HttpError(401, 'unauthenticated');
      return session;
    },
    requireFresh(session) {
      if (now() - session.auth_at > FRESH_MS) throw new HttpError(401, 'reauth_required');
    },
    revoke(idHash) {
      revokeOne.run(now(), idHash);
    },
    revokeOthers(userId, keepIdHash) {
      return revokeUser.run(now(), userId, keepIdHash ?? '').changes;
    },
    revokeSetup(userId) {
      return revokeUserSetup.run(now(), userId).changes;
    },
    hasLive(userId) {
      return live.get(userId, now()) !== undefined;
    },
  };
}
