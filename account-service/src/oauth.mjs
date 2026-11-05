import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.mjs';
import { getUser } from './users.mjs';

// Desktop sign-in (design 4.4, RFC 6749/7636/8252). The desktop is a public client: there is no
// client secret, PKCE binds the code to the machine that started the flow.
export const CLIENT_ID = 'llmide-desktop';
export const CODE_TTL_MS = 60_000;
export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;

const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/auth\/callback$/;
const CUSTOM_REDIRECT = 'llmide://auth/callback';
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE_RE = /^[\x21-\x7e]{1,256}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hash = (value) => createHash('sha256').update(value).digest('hex');
const invalidGrant = () => new HttpError(400, 'invalid_grant');

// The custom scheme is the fallback; loopback is the default because another local app can claim a
// scheme, but cannot claim 127.0.0.1. The redirect URI is compared as an exact string.
export function validRedirectUri(value) {
  if (value === CUSTOM_REDIRECT) return true;
  const match = typeof value === 'string' ? LOOPBACK_REDIRECT.exec(value) : null;
  if (!match) return false;
  const port = Number(match[1]);
  // Canonical decimal form only: the stored redirect URI is later compared as an exact string.
  return port >= 1024 && port <= 65535 && String(port) === match[1];
}

export const validChallenge = (value) => typeof value === 'string' && CHALLENGE_RE.test(value);
export const validState = (value) => typeof value === 'string' && STATE_RE.test(value);

function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  const expected = Buffer.from(challenge);
  const actual = Buffer.from(computed);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Signs the account out of every desktop: revokes all desktop token families and drops pending sign-in
// codes. Callers run it inside their own transaction (recovery, device revoke). keepFamily spares the
// caller's own family (replace).
export function revokeDesktopSignIns(db, t, userId, keepFamily = null) {
  db.prepare('UPDATE desktop_tokens SET revoked_at = ? WHERE user_id = ? AND family IS NOT ? AND revoked_at IS NULL')
    .run(t, userId, keepFamily);
  db.prepare('DELETE FROM oauth_codes WHERE user_id = ? AND used_at IS NULL').run(userId);
}

export function createOAuth(db, now) {
  const insertCode = db.prepare(
    `INSERT INTO oauth_codes (code_hash, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at, auth_at)
     VALUES (?, ?, ?, ?, ?, 'S256', ?, ?, ?)`,
  );
  const codeByHash = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?');
  const markCodeUsed = db.prepare('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL');
  const insertToken = db.prepare(
    `INSERT INTO desktop_tokens (id_hash, user_id, family, kind, client_id, code_hash, created_at, expires_at, auth_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tokenByHash = db.prepare('SELECT * FROM desktop_tokens WHERE id_hash = ?');
  const markTokenUsed = db.prepare('UPDATE desktop_tokens SET used_at = ? WHERE id_hash = ? AND used_at IS NULL');
  const revokeFamily = db.prepare('UPDATE desktop_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL');
  // RFC 6749 4.1.2: a replayed code revokes every token previously issued from it.
  const revokeCodeTokens = db.prepare('UPDATE desktop_tokens SET revoked_at = ? WHERE code_hash = ? AND revoked_at IS NULL');

  // authAt: when the passkey proof behind this sign-in happened; rotation keeps it, never refreshes it.
  function issuePair(userId, family, clientId, codeHash, authAt) {
    const accessToken = randomBytes(32).toString('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    const t = now();
    insertToken.run(hash(accessToken), userId, family, 'access', clientId, codeHash, t, t + ACCESS_TTL_MS, authAt);
    insertToken.run(hash(refreshToken), userId, family, 'refresh', clientId, codeHash, t, t + REFRESH_TTL_MS, authAt);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_MS / 1000,
      refresh_token: refreshToken,
    };
  }

  return {
    issueCode({ userId, redirectUri, challenge, authAt }) {
      const code = randomBytes(32).toString('base64url');
      const t = now();
      insertCode.run(hash(code), userId, CLIENT_ID, redirectUri, challenge, t, t + CODE_TTL_MS, authAt);
      return code;
    },

    exchangeCode({ code, clientId, redirectUri, verifier }) {
      if (clientId !== CLIENT_ID) throw new HttpError(400, 'invalid_client');
      if (typeof code !== 'string' || !TOKEN_RE.test(code)) throw invalidGrant();
      const codeHash = hash(code);
      const row = codeByHash.get(codeHash);
      if (!row) throw invalidGrant();
      const t = now();
      if (row.used_at !== null) {
        revokeCodeTokens.run(t, codeHash);
        throw invalidGrant();
      }
      if (row.expires_at <= t) throw invalidGrant();
      if (row.client_id !== clientId || row.redirect_uri !== redirectUri) throw invalidGrant();
      if (!pkceMatches(verifier, row.code_challenge)) throw invalidGrant();
      const family = randomBytes(16).toString('base64url');
      const tokens = db.transaction(() => {
        if (markCodeUsed.run(t, codeHash).changes !== 1) throw invalidGrant();
        return issuePair(row.user_id, family, clientId, codeHash, row.auth_at);
      })();
      return { userId: row.user_id, tokens };
    },

    revokeRefresh({ refreshToken, clientId }) {
      if (clientId !== CLIENT_ID) throw new HttpError(400, 'invalid_client');
      if (typeof refreshToken !== 'string' || !TOKEN_RE.test(refreshToken)) return false;
      const row = tokenByHash.get(hash(refreshToken));
      if (!row || row.kind !== 'refresh' || row.client_id !== clientId) return false;
      revokeFamily.run(now(), row.family);
      return true;
    },

    rotateRefresh({ refreshToken, clientId }) {
      if (clientId !== CLIENT_ID) throw new HttpError(400, 'invalid_client');
      if (typeof refreshToken !== 'string' || !TOKEN_RE.test(refreshToken)) throw invalidGrant();
      const row = tokenByHash.get(hash(refreshToken));
      if (!row || row.kind !== 'refresh' || row.client_id !== clientId) throw invalidGrant();
      const t = now();
      if (row.revoked_at !== null) throw invalidGrant();
      if (row.used_at !== null) {
        revokeFamily.run(t, row.family); // refresh reuse revokes the whole family
        throw invalidGrant();
      }
      if (row.expires_at <= t) throw invalidGrant();
      const tokens = db.transaction(() => {
        if (markTokenUsed.run(t, row.id_hash).changes !== 1) throw invalidGrant();
        return issuePair(row.user_id, row.family, clientId, row.code_hash, row.auth_at);
      })();
      return { userId: row.user_id, tokens };
    },

    // Bearer access tokens are opaque and hashed at rest; there is no JWT and no signing key.
    requireAccess(req) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? '');
      if (!match) throw new HttpError(401, 'unauthenticated');
      const row = tokenByHash.get(hash(match[1]));
      if (!row || row.kind !== 'access' || row.revoked_at !== null || row.expires_at <= now()) {
        throw new HttpError(401, 'unauthenticated');
      }
      const user = getUser(db, row.user_id);
      if (!user || user.status !== 'active') throw new HttpError(401, 'unauthenticated');
      return { user, token: row };
    },
  };
}
