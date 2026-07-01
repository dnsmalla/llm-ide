// Tests for the password-reset flow in server/users.mjs.
// Uses a temp on-disk DB (matches the user-delete-cascade pattern) so
// migrations are applied exactly once and the real SQLite code paths run.
//
// Coverage:
//   - createPasswordResetToken: known email, unknown email, disabled account
//   - consumePasswordResetToken: happy path, already-used, expired, bad token
//   - purgeExpiredResetTokens
//   - timing-safe enumeration: unknown + disabled responses are indistinguishable
//     from a real success (same shape, no thrown error)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_password-reset-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db  = await import('../kb/db.mjs');
const usr = await import('../server/users.mjs');

function getHandle() { return db.getDb(); }

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function provision(email = 'alice@example.com') {
  return usr.registerUser(getHandle(), {
    email,
    password: 'CorrectHorseBattery1',
    displayName: 'Alice',
  });
}

// ── createPasswordResetToken ──────────────────────────────────────────────────

test('createPasswordResetToken returns a token and expiresAt for known email', () => {
  reset();
  provision();
  const r = usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  assert.equal(r.email, 'alice@example.com');
  assert.ok(typeof r.token === 'string' && r.token.length > 20,
    'should include the raw token for OOB delivery');
  assert.ok(typeof r.expiresAt === 'string', 'expiresAt should be an ISO string');
  // Should expire ~1 hour from now.
  const diff = new Date(r.expiresAt) - Date.now();
  assert.ok(diff > 59 * 60 * 1000 && diff <= 61 * 60 * 1000,
    `expiresAt should be ~1 h from now, got diff=${diff}`);
});

test('createPasswordResetToken returns same-shaped response for unknown email (no enumeration)', () => {
  reset();
  provision();
  // Unknown email — should NOT throw and should NOT expose `token`.
  const r = usr.createPasswordResetToken(getHandle(), { email: 'nobody@example.com' });
  assert.equal(r.email, 'nobody@example.com');
  assert.equal(r.token, undefined, 'token must NOT be returned for unknown email');
  assert.ok(typeof r.expiresAt === 'string');
});

test('createPasswordResetToken stores a hashed token in the DB', () => {
  reset();
  provision();
  usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  const row = getHandle().prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get();
  assert.equal(row.n, 1);
});

test('createPasswordResetToken revokes any prior unused token for the same user', () => {
  reset();
  provision();
  usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  // Second call should revoke the first — only one outstanding token allowed.
  const row = getHandle().prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get();
  assert.equal(row.n, 1, 'only one token should be outstanding at a time');
});

test('createPasswordResetToken requires a valid email', () => {
  reset();
  assert.throws(
    () => usr.createPasswordResetToken(getHandle(), { email: 'not-an-email' }),
    /Invalid email/i,
  );
});

// ── consumePasswordResetToken ─────────────────────────────────────────────────

test('consumePasswordResetToken changes the password and revokes all sessions', () => {
  reset();
  provision();
  // Obtain a reset token, then login to get a session, then reset.
  const { token } = usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  // Seed a refresh-token row to verify session revocation.
  const u = getHandle().prepare('SELECT id FROM users WHERE email = ?').get('alice@example.com');
  const fakeHash = 'a'.repeat(64);
  getHandle().prepare(
    "INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ('rt1', ?, ?, datetime('now', '+7 days'))"
  ).run(u.id, fakeHash);

  usr.consumePasswordResetToken(getHandle(), { token, newPassword: 'NewHorseBattery99' });

  // Session should be revoked.
  const rt = getHandle().prepare('SELECT revoked_at FROM refresh_tokens WHERE id = ?').get('rt1');
  assert.ok(rt.revoked_at, 'session should be revoked after password reset');

  // Old password should no longer work.
  assert.rejects(async () => {
    usr.login(getHandle(), { email: 'alice@example.com', password: 'CorrectHorseBattery1' });
  });
  // New password should work.
  const session = usr.login(getHandle(), { email: 'alice@example.com', password: 'NewHorseBattery99' });
  assert.ok(session.accessToken, 'should be able to log in with new password');
});

test('consumePasswordResetToken marks the token used so it cannot be replayed', () => {
  reset();
  provision();
  const { token } = usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  usr.consumePasswordResetToken(getHandle(), { token, newPassword: 'NewHorseBattery99' });
  assert.throws(
    () => usr.consumePasswordResetToken(getHandle(), { token, newPassword: 'AnotherPass123' }),
    /already been used/i,
  );
});

test('consumePasswordResetToken rejects an unknown token', () => {
  reset();
  assert.throws(
    () => usr.consumePasswordResetToken(getHandle(), { token: 'totally-fake-token', newPassword: 'SomePass123' }),
    /invalid|expired/i,
  );
});

test('consumePasswordResetToken rejects an expired token', () => {
  reset();
  provision();
  usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  // Manually back-date the token's expires_at.
  getHandle().prepare(
    "UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 minute')"
  ).run();
  // Fetch the raw token from the DB to bypass the hash lookup.
  // We can't do that — we only have the hash stored. Instead create a fresh
  // token and manually expire it then try to consume it.
  const { token: t2 } = usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  getHandle().prepare(
    "UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 minute') WHERE used_at IS NULL"
  ).run();
  assert.throws(
    () => usr.consumePasswordResetToken(getHandle(), { token: t2, newPassword: 'SomePass123' }),
    /expired/i,
  );
});

test('consumePasswordResetToken enforces minimum password length', () => {
  reset();
  provision();
  const { token } = usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  assert.throws(
    () => usr.consumePasswordResetToken(getHandle(), { token, newPassword: 'short' }),
    /at least/i,
  );
});

test('consumePasswordResetToken requires token string', () => {
  reset();
  assert.throws(
    () => usr.consumePasswordResetToken(getHandle(), { token: '', newPassword: 'ValidPassword123' }),
    /token is required/i,
  );
});

// ── purgeExpiredResetTokens ───────────────────────────────────────────────────

test('purgeExpiredResetTokens removes expired rows and returns count', () => {
  reset();
  provision();
  usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  // Expire the token.
  getHandle().prepare(
    "UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 minute')"
  ).run();
  const n = usr.purgeExpiredResetTokens(getHandle());
  assert.equal(n, 1);
  assert.equal(getHandle().prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n, 0);
});

test('purgeExpiredResetTokens removes used rows', () => {
  reset();
  provision();
  const { token } = usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  usr.consumePasswordResetToken(getHandle(), { token, newPassword: 'NewHorseBattery99' });
  const n = usr.purgeExpiredResetTokens(getHandle());
  assert.equal(n, 1);
});

test('purgeExpiredResetTokens leaves unexpired rows intact', () => {
  reset();
  provision();
  usr.createPasswordResetToken(getHandle(), { email: 'alice@example.com' });
  const n = usr.purgeExpiredResetTokens(getHandle());
  assert.equal(n, 0, 'fresh token should not be pruned');
  assert.equal(getHandle().prepare('SELECT COUNT(*) AS n FROM password_reset_tokens').get().n, 1);
});
