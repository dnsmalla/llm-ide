// SRV: a "revoke all sessions" (logoutAll / password reset) must invalidate
// outstanding ACCESS tokens too, not just refresh tokens — otherwise a stolen
// bearer token keeps working until its (<=15 min) TTL. Enforced by a per-user
// tokens_valid_after cutoff checked in authenticate().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_access-token-epoch-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { authenticate } = await import('../server/auth.mjs');
const { signAccessToken } = await import('../server/jwt.mjs');

let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `epoch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'epoch',
  }).id;
}

function reqWith(token) {
  // A protected path so authenticate() proceeds to token validation.
  return { method: 'POST', url: '/kb/search', headers: { authorization: `Bearer ${token}` } };
}

function setCutoff(epochSec) {
  db.getDb().prepare('UPDATE users SET tokens_valid_after = ? WHERE id = ?').run(epochSec, String(U));
}

test('fresh access token authenticates when no cutoff is set', () => {
  reset();
  const req = reqWith(signAccessToken({ userId: U, role: 'user' }));
  assert.equal(authenticate(req), true);
  assert.equal(req.user.id, String(U));
});

test('tokensValidAfter starts at 0 and logoutAll bumps it', () => {
  reset();
  assert.equal(db.tokensValidAfter(U), 0);
  users.logoutAll(db.getDb(), U);
  assert.ok(db.tokensValidAfter(U) > 0, 'logoutAll must set a per-user token cutoff');
});

test('authenticate REJECTS an access token issued before the cutoff', () => {
  reset();
  const token = signAccessToken({ userId: U, role: 'user' });   // iat = now
  setCutoff(Math.floor(Date.now() / 1000) + 1000);              // cutoff in the future
  assert.throws(() => authenticate(reqWith(token)), /revoked|sign in/i);
});

test('authenticate accepts a token issued after the cutoff', () => {
  reset();
  setCutoff(Math.floor(Date.now() / 1000) - 1000);             // cutoff in the past
  const req = reqWith(signAccessToken({ userId: U, role: 'user' }));
  assert.equal(authenticate(req), true);
});
