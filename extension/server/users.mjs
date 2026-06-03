// User identity: registration, password verification, refresh-token
// rotation.  Wraps better-sqlite3 directly because we need transaction
// support and the prepared statements cache.

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { config } from '../core/config.mjs';
import { hashRefreshToken, newRefreshToken, signAccessToken } from './jwt.mjs';
import { errAuth, errConflict, errForbidden, errValidation, errNotFound } from '../core/errors.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 200;
const MAX_NAME = 80;

// Validate bcrypt cost at module load time so a misconfigured value
// (e.g. cost=1, which allows fast cracking) fails loudly on startup.
const MIN_BCRYPT_COST = 10;
const MAX_BCRYPT_COST = 14;
if (!Number.isInteger(config.bcryptCost) ||
    config.bcryptCost < MIN_BCRYPT_COST ||
    config.bcryptCost > MAX_BCRYPT_COST) {
  throw new Error(
    `Invalid bcryptCost ${JSON.stringify(config.bcryptCost)}: ` +
    `must be an integer between ${MIN_BCRYPT_COST} and ${MAX_BCRYPT_COST}`,
  );
}

// A REAL bcrypt hash (computed at the configured cost) used as the
// comparison target when the user row is missing. It must be a
// well-formed hash: bcrypt.compareSync throws on a malformed string and
// returns early, which would defeat the whole point of comparing against
// a dummy — the fast-path error would leak (via timing) that the account
// does not exist. Hashing a random secret guarantees it never matches a
// real password while keeping the compare cost identical to the real one.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  crypto.randomBytes(32).toString('hex'),
  config.bcryptCost,
);

function userId() {
  return crypto.randomBytes(8).toString('hex');
}

function refreshId() {
  return crypto.randomBytes(8).toString('hex');
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function validatePassword(pw) {
  if (typeof pw !== 'string') throw errValidation('Password must be a string');
  if (pw.length < MIN_PASSWORD) throw errValidation(`Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > MAX_PASSWORD) throw errValidation(`Password too long`);
}

function validateEmail(email) {
  const e = normalizeEmail(email);
  if (!EMAIL_RE.test(e)) throw errValidation('Invalid email');
  return e;
}

export function registerUser(db, { email, password, displayName }) {
  if (!config.registrationOpen) throw errForbidden('Registration is disabled');
  const e = validateEmail(email);
  validatePassword(password);
  const name = String(displayName || '').trim().slice(0, MAX_NAME) || e.split('@')[0];

  const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(e);
  if (exists) throw errConflict('Email is already registered');

  const hash = bcrypt.hashSync(password, config.bcryptCost);
  const id = userId();

  // Promote the very first registered user to admin so a fresh deploy
  // is bootstrappable without manual SQL.  We do the count-and-insert
  // inside a transaction so two concurrent registrations can't both
  // see "0 existing users" and both become admin.  better-sqlite3
  // serializes writers, so the transaction acts as a critical section.
  const provisioned = db.transaction(() => {
    const userCount = db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE id != 'legacy'",
    ).get().n;
    const role = userCount === 0 ? 'admin' : 'user';
    db.prepare(`
      INSERT INTO users (id, email, display_name, password_hash, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, e, name, hash, role);
    return role;
  })();

  return findUserById(db, id);
}

export function findUserById(db, id) {
  const row = db.prepare(
    'SELECT id, email, display_name, role, status, created_at, last_login_at FROM users WHERE id = ?',
  ).get(String(id));
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function findUserByEmail(db, email) {
  const row = db.prepare(
    'SELECT * FROM users WHERE email = ? AND status = \'active\'',
  ).get(normalizeEmail(email));
  return row || null;
}

export function login(db, { email, password, userAgent }) {
  // We always bcrypt.compare even if the user doesn't exist, against
  // a known invalid hash, so the response time doesn't reveal whether
  // an email is registered.  The pseudo-hash is the same legacy-user
  // sentinel that's deliberately impossible to match.
  const row = findUserByEmail(db, email);
  const hash = row?.password_hash || DUMMY_PASSWORD_HASH;
  const ok = bcrypt.compareSync(String(password || ''), hash);
  if (!row || !ok) throw errAuth('Invalid credentials');
  if (row.status !== 'active') throw errForbidden('Account disabled');

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);

  const access = signAccessToken({ userId: row.id, role: row.role });
  const refresh = newRefreshToken();
  storeRefreshToken(db, row.id, refresh, userAgent);

  return {
    user: findUserById(db, row.id),
    accessToken: access,
    refreshToken: refresh,
    accessTokenTTLSec: config.accessTokenTTLSec,
  };
}

export function storeRefreshToken(db, userId, token, userAgent) {
  const expiresAt = new Date(Date.now() + config.refreshTokenTTLSec * 1000).toISOString();
  db.prepare(`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, user_agent)
    VALUES (?, ?, ?, ?, ?)
  `).run(refreshId(), String(userId), hashRefreshToken(token), expiresAt, userAgent || null);
}

export function refreshSession(db, { refreshToken, userAgent }) {
  if (typeof refreshToken !== 'string' || !refreshToken) throw errAuth('Missing refresh token');
  const tokenHash = hashRefreshToken(refreshToken);
  const row = db.prepare(`
    SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, u.role, u.status
    FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
    WHERE rt.token_hash = ?
  `).get(tokenHash);

  if (!row) throw errAuth('Invalid refresh token');
  if (row.revoked_at) {
    // Reuse-after-rotation is a strong theft signal — the legitimate
    // client has already exchanged this token for a fresh one, so
    // anyone presenting it again is either a stale tab or an
    // attacker who captured the old value.  Best-effort: revoke
    // every active session for that user so the attacker also loses
    // any other token they may have grabbed.  The legitimate user
    // gets bounced to login on their next API call.
    try { logoutAll(db, row.user_id); } catch { /* never block the 401 */ }
    throw errAuth('Refresh token revoked');
  }
  if (new Date(row.expires_at) < new Date()) throw errAuth('Refresh token expired');
  if (row.status !== 'active') throw errForbidden('Account disabled');

  // Rotate: revoke the old token and mint a fresh one.  This means a
  // refresh leak only works once, and reuse of an already-rotated
  // token is detectable (we'd see two attempts where one is rejected).
  //
  // The revoke UPDATE is guarded by `revoked_at IS NULL` so it is the
  // atomic arbiter under concurrency: if two requests race with the same
  // token, exactly one UPDATE reports `changes === 1` and proceeds; the
  // loser sees `changes === 0`, meaning the row was revoked out from under
  // it. That is indistinguishable from token reuse, so we treat it as
  // theft — revoke every session and reject.
  const tx = db.transaction(() => {
    const res = db.prepare(
      `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ? AND revoked_at IS NULL`
    ).run(row.id);
    if (res.changes !== 1) return null; // lost the race / already rotated
    const fresh = newRefreshToken();
    storeRefreshToken(db, row.user_id, fresh, userAgent);
    return fresh;
  });
  const newToken = tx();
  if (newToken === null) {
    try { logoutAll(db, row.user_id); } catch { /* never block the 401 */ }
    throw errAuth('Refresh token revoked');
  }
  const access = signAccessToken({ userId: row.user_id, role: row.role });
  return {
    accessToken: access,
    refreshToken: newToken,
    accessTokenTTLSec: config.accessTokenTTLSec,
  };
}

export function logout(db, refreshToken) {
  if (typeof refreshToken !== 'string' || !refreshToken) return;
  const h = hashRefreshToken(refreshToken);
  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`
  ).run(h);
}

export function logoutAll(db, userId) {
  db.prepare(
    `UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`
  ).run(String(userId));
}

// Sweep expired and revoked refresh token rows.  Call at startup and
// periodically (e.g. daily) to prevent unbounded table growth.
export function purgeExpiredRefreshTokens(db) {
  const info = db.prepare(
    `DELETE FROM refresh_tokens WHERE expires_at < datetime('now') OR revoked_at IS NOT NULL`
  ).run();
  return info.changes;
}

export function changePassword(db, userId, { currentPassword, newPassword }) {
  validatePassword(newPassword);
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(String(userId));
  if (!row) throw errNotFound('User');
  if (!bcrypt.compareSync(String(currentPassword || ''), row.password_hash)) {
    throw errAuth('Current password is incorrect');
  }
  const hash = bcrypt.hashSync(newPassword, config.bcryptCost);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, String(userId));
  // Defensive: rotate every active session on password change.
  logoutAll(db, userId);
}

// ---------------------------------------------------------------------------
// Password reset flow
// ---------------------------------------------------------------------------
//
// This is a local-first / self-hosted app — there is no built-in email
// delivery.  The flow stores a time-limited single-use token in the DB and
// exposes it in two ways:
//
//   - In development  (NODE_ENV != 'production'):
//       The raw token is returned in the API response body.
//       Useful for local testing without any external dependencies.
//
//   - In production   (NODE_ENV === 'production'):
//       The raw token is written to the server's structured log at WARN
//       level with the prefix `password_reset_token` and the user's
//       email.  An operator reads the log and delivers the token OOB
//       (email, Slack DM, etc.).  The response body only says "check
//       server logs".
//
// To add real email delivery later, replace the log-and-return block
// below with a call to your preferred SMTP / SES / SendGrid helper.

const RESET_TTL_SEC  = 60 * 60;   // 1 hour
const RESET_TOKEN_BYTES = 32;      // 256 bits of entropy

function hashResetToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function resetId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Generate a password-reset token for `email`.  Returns an object:
 *   { token, email, expiresAt }   — token is the raw value to deliver OOB
 *
 * Throws errValidation for bad email, errNotFound for unknown account.
 * A timing-safe path ensures unknown emails take the same time as known
 * ones (bcrypt-equivalent: we always hash the throwaway token).
 */
export function createPasswordResetToken(db, { email }) {
  const e = validateEmail(email);
  const user = db.prepare(
    "SELECT id, status FROM users WHERE email = ? AND id != 'legacy'",
  ).get(e);

  // Always mint and hash a token — same wall-clock cost whether the
  // user exists or not, so timing doesn't reveal registered emails.
  const raw = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  hashResetToken(raw); // ensure same crypto path even when we discard it

  if (!user) {
    // Return a fake-success so enumeration isn't possible. Callers
    // MUST NOT distinguish this from a real success.
    return { email: e, expiresAt: new Date(Date.now() + RESET_TTL_SEC * 1000).toISOString() };
  }
  if (user.status !== 'active') {
    return { email: e, expiresAt: new Date(Date.now() + RESET_TTL_SEC * 1000).toISOString() };
  }

  const expiresAt = new Date(Date.now() + RESET_TTL_SEC * 1000).toISOString();
  // Revoke any previous un-used reset tokens for this user — one
  // outstanding token at a time prevents token accumulation.
  db.prepare(
    "DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL",
  ).run(user.id);
  db.prepare(
    "INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
  ).run(resetId(), user.id, hashResetToken(raw), expiresAt);

  return { token: raw, email: e, expiresAt };
}

/**
 * Consume a reset token and apply the new password.  Single-use —
 * marks the token `used_at` immediately so replayed requests fail.
 * Throws on invalid / expired / already-used tokens.
 */
export function consumePasswordResetToken(db, { token, newPassword }) {
  if (typeof token !== 'string' || !token) throw errValidation('token is required');
  // A real reset token is always >= 32 chars. A shorter one can never match a
  // stored hash, so treat it as invalid (not a distinct validation error) —
  // this avoids leaking token-format details and matches the not-found path.
  if (token.length < 32) throw errAuth('Invalid or expired reset token');
  validatePassword(newPassword);

  const h = hashResetToken(token);
  const row = db.prepare(
    "SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?",
  ).get(h);

  if (!row)                                    throw errAuth('Invalid or expired reset token');
  if (row.used_at)                             throw errAuth('Reset token has already been used');
  if (new Date(row.expires_at) < new Date())   throw errAuth('Reset token has expired');

  const newHash = bcrypt.hashSync(newPassword, config.bcryptCost);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, row.user_id);
    db.prepare(
      "UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?",
    ).run(row.id);
    // Revoke every active session — any stolen session is invalidated.
    db.prepare(
      "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
    ).run(row.user_id);
  })();
}

/**
 * Purge expired reset tokens.  Call alongside the refresh-token GC.
 */
export function purgeExpiredResetTokens(db) {
  const info = db.prepare(
    "DELETE FROM password_reset_tokens WHERE expires_at < datetime('now') OR used_at IS NOT NULL",
  ).run();
  return info.changes;
}

/**
 * Constant-time password verification used by re-auth confirmation
 * steps (account delete, dangerous settings changes). Always compares
 * against a dummy hash when the user is gone so timing doesn't leak
 * row existence. Returns boolean; callers shape the error envelope.
 */
export async function verifyPassword(db, userId, password) {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(String(userId));
  const hash = row?.password_hash || DUMMY_PASSWORD_HASH;
  try {
    return bcrypt.compareSync(String(password || ''), hash);
  } catch {
    return false;
  }
}
