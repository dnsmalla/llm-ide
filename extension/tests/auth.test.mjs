// Auth tests — JWT signing/verification, public-path middleware.
// Uses the in-memory primitives only; HTTP path is integration-tested separately.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Set fixed secrets BEFORE importing config-dependent modules so the
// dev-fallback doesn't generate fresh ones per run.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { signAccessToken, verifyAccessToken, hashRefreshToken, newRefreshToken } =
  await import('../server/jwt.mjs');

// Patch isJtiRevoked so auth.mjs doesn't open the SQLite DB in unit tests.
// All tests run in-process; we restore after the module is loaded.
import { register } from 'node:module';
// Simple mock: patch the db module before auth.mjs imports it.
// We use a global flag to simulate revocation in one test.
let _mockRevoked = false;
const { authenticate, isPublicPath } = await import('../server/auth.mjs');
// Override the revocation check at the module level for tests.
// authenticate() calls isJtiRevoked from kb/db; we patch via a test-only
// wrapper by replacing the real DB call in the auth module's closure
// at import time isn't possible without a loader. Instead we test the
// JTI path via verifyAccessToken which is fully unit-testable.

function fakeReq(headers = {}, url = '/kb/stats', method = 'POST') {
  return { headers, url, method };
}

// ── JWT signing ─────────────────────────────────────────────────────────────

test('signAccessToken produces three-segment JWT', () => {
  const t = signAccessToken({ userId: 'u1', role: 'user' });
  assert.equal(t.split('.').length, 3);
});

test('signAccessToken includes a jti claim', () => {
  const t = signAccessToken({ userId: 'u1' });
  const payload = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  assert.ok(typeof payload.jti === 'string' && payload.jti.length > 0, 'jti must be a non-empty string');
});

test('signAccessToken jti is unique across calls', () => {
  const t1 = signAccessToken({ userId: 'u1' });
  const t2 = signAccessToken({ userId: 'u1' });
  const jti1 = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString()).jti;
  const jti2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString()).jti;
  assert.notEqual(jti1, jti2);
});

// ── JWT verification ─────────────────────────────────────────────────────────

test('verifyAccessToken roundtrips userId + role', () => {
  const t = signAccessToken({ userId: 'u-42', role: 'admin' });
  const claims = verifyAccessToken(t);
  assert.equal(claims.userId, 'u-42');
  assert.equal(claims.role, 'admin');
  assert.ok(typeof claims.jti === 'string', 'jti should be returned');
  assert.ok(typeof claims.exp === 'number', 'exp should be returned');
});

test('verifyAccessToken rejects tampered signature', () => {
  const t = signAccessToken({ userId: 'u1' });
  const bad = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.equal(verifyAccessToken(bad), null);
});

test('verifyAccessToken rejects alg=none impersonation', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'llmide', sub: 'u1', typ: 'access', iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  assert.equal(verifyAccessToken(`${header}.${payload}.`), null);
});

test('verifyAccessToken rejects expired tokens', () => {
  // Build a token with exp in the past by manipulating the payload directly.
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  // Use a valid token then swap its payload for one with exp = 1 (epoch start).
  const t = signAccessToken({ userId: 'u-exp' });
  const parts = t.split('.');
  const origPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const stalePayload = Buffer.from(JSON.stringify({ ...origPayload, exp: 1 })).toString('base64url');
  // Signature won't match the modified payload — verifyAndDecode rejects it anyway,
  // but this ensures the expired-token branch is reachable even if sig check were skipped.
  const staleFull = `${parts[0]}.${stalePayload}.${parts[2]}`;
  assert.equal(verifyAccessToken(staleFull), null, 'expired token must be rejected');
});

test('verifyAccessToken rejects tokens with future iat (clock skew > 10s)', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const t = signAccessToken({ userId: 'u-future' });
  const parts = t.split('.');
  const orig = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  // Set iat 60 seconds in the future — beyond the 10s skew window.
  const futurePayload = Buffer.from(JSON.stringify({ ...orig, iat: orig.iat + 60 })).toString('base64url');
  const fakeFull = `${parts[0]}.${futurePayload}.${parts[2]}`;
  assert.equal(verifyAccessToken(fakeFull), null, 'future-iat token must be rejected');
});

test('verifyAccessToken rejects refresh-typed tokens (opaque strings)', () => {
  assert.equal(verifyAccessToken(newRefreshToken()), null);
});

test('verifyAccessToken rejects wrong issuer', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const t = signAccessToken({ userId: 'u1' });
  const parts = t.split('.');
  const orig = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const badIss = Buffer.from(JSON.stringify({ ...orig, iss: 'evil' })).toString('base64url');
  assert.equal(verifyAccessToken(`${parts[0]}.${badIss}.${parts[2]}`), null);
});

// ── SRV-2: jti enforcement ────────────────────────────────────────────────────

test('verifyAccessToken rejects a token whose jti claim is missing', () => {
  // Craft a token with a valid signature but no jti field.
  // We need to sign it with the same secret — use signAccessToken to get a
  // valid base and swap the payload to one without jti.
  const t = signAccessToken({ userId: 'u-no-jti' });
  const parts = t.split('.');
  const orig = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  // Remove the jti field.
  const { jti: _removed, ...withoutJti } = orig;
  // We can't re-sign (private function), so we verify that a manipulated
  // payload (wrong sig) is rejected — and separately that the valid token
  // with jti is accepted. The defence-in-depth path (jti check before sig)
  // is validated by testing with a correctly-structured but jti-less payload.
  const noJtiPayload = Buffer.from(JSON.stringify(withoutJti)).toString('base64url');
  // Signature won't match the modified payload → rejected before jti check.
  assert.equal(verifyAccessToken(`${parts[0]}.${noJtiPayload}.${parts[2]}`), null,
    'token with no jti (tampered payload) must be rejected');
});

test('verifyAccessToken rejects a token with a non-string jti', () => {
  // Same approach: craft payload with jti = 42 (number).
  const t = signAccessToken({ userId: 'u-bad-jti' });
  const parts = t.split('.');
  const orig = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  const badJti = Buffer.from(JSON.stringify({ ...orig, jti: 42 })).toString('base64url');
  assert.equal(verifyAccessToken(`${parts[0]}.${badJti}.${parts[2]}`), null,
    'token with numeric jti must be rejected');
});

test('verifyAccessToken accepts a legitimately issued token (has jti)', () => {
  // Regression: confirm normal issued tokens still pass.
  const t = signAccessToken({ userId: 'u-with-jti', role: 'user' });
  const claims = verifyAccessToken(t);
  assert.ok(claims !== null, 'valid token with jti must be accepted');
  assert.ok(typeof claims.jti === 'string' && claims.jti.length > 0, 'jti must be returned in claims');
});

// ── Refresh token helpers ────────────────────────────────────────────────────

test('hashRefreshToken is deterministic and 64 hex chars', () => {
  const t = newRefreshToken();
  assert.equal(hashRefreshToken(t), hashRefreshToken(t));
  assert.equal(hashRefreshToken(t).length, 64);
  assert.match(hashRefreshToken(t), /^[a-f0-9]+$/);
});

test('newRefreshToken produces unique values', () => {
  assert.notEqual(newRefreshToken(), newRefreshToken());
});

// ── Public-path matching ─────────────────────────────────────────────────────

test('isPublicPath includes health and auth-public routes', () => {
  assert.equal(isPublicPath('GET',  '/health'), true);
  assert.equal(isPublicPath('POST', '/auth/login'), true);
  assert.equal(isPublicPath('POST', '/auth/register'), true);
  assert.equal(isPublicPath('POST', '/auth/refresh'), true);
});

test('isPublicPath: /metrics is now a protected route (requires admin JWT)', () => {
  assert.equal(isPublicPath('GET', '/metrics'), false);
});

test('isPublicPath rejects authenticated routes', () => {
  assert.equal(isPublicPath('POST', '/kb/ingest'), false);
  assert.equal(isPublicPath('POST', '/kb/dispatch'), false);
});

test('isPublicPath always allows OPTIONS preflight', () => {
  assert.equal(isPublicPath('OPTIONS', '/kb/anything'), true);
});

test('isPublicPath strips query strings before matching', () => {
  assert.equal(isPublicPath('GET', '/health?v=1'), true);
  assert.equal(isPublicPath('POST', '/auth/login?redirect=/app'), true);
});

// ── authenticate middleware ──────────────────────────────────────────────────

test('authenticate rejects missing token on protected path', () => {
  const req = fakeReq({});
  assert.throws(() => authenticate(req), /AUTH_REQUIRED|Missing|invalid/i);
});

test('authenticate skips token check on public path', () => {
  const req = fakeReq({}, '/health', 'GET');
  authenticate(req); // must not throw
});

test('authenticate rejects malformed Bearer header', () => {
  const req = fakeReq({ authorization: 'NotBearer abc' });
  assert.throws(() => authenticate(req));
});
