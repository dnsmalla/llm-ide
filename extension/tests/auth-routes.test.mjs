// HTTP-level tests for server/auth-routes.mjs handleAuth().
// Uses the same req/res double pattern as activity-routes.test.mjs.
// NOTE: rate-limit buckets are module-global — each test uses a unique
// fake IP (auto-incremented) unless it is specifically testing limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_auth-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth, isAuthRoute } = await import('../server/auth-routes.mjs');
const { authenticate, isPublicPath } = await import('../server/auth.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user, headers = {}, ip }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    headers,
    user,
    socket: { remoteAddress: ip || `10.0.0.${++ipCounter}` },
    on(event, cb) {
      if (event === 'data') chunks.forEach((c) => cb(c));
      else if (event === 'end') cb();
      return req;
    },
  };
  return req;
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    _body: '',
    headersSent: false,
    writeHead(code, headers) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}

async function callAuth(reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  await handleAuth(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });
  return res;
}

let emailCounter = 0;
function uniqueEmail() { return `auth-routes-${Date.now()}-${++emailCounter}@example.com`; }
const PASSWORD = 'CorrectHorseBattery';

async function registerAndLogin() {
  const email = uniqueEmail();
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD, displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login._body);
  return { email, ...login.json() };
}

// ---- routing predicate -------------------------------------------------

test('isAuthRoute matches auth paths and strips query strings', () => {
  assert.equal(isAuthRoute('/auth/login'), true);
  assert.equal(isAuthRoute('/auth/me/audit?limit=5'), true);
  assert.equal(isAuthRoute('/kb/search'), false);
  assert.equal(isAuthRoute('/auth/definitely-not-a-route'), false);
});

// ---- public routes -----------------------------------------------------

test('GET /auth/well-known exposes discovery fields', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/well-known' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(typeof body.registrationOpen, 'boolean');
  assert.ok(Array.isArray(body.vaultKeys) && body.vaultKeys.includes('github.token'));
});

test('POST /auth/register creates a user; duplicate email is refused', async () => {
  const email = uniqueEmail();
  const res = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD } });
  assert.equal(res.statusCode, 201, res._body);
  const user = res.json().user;
  assert.equal(user.email, email);
  assert.ok(user.id);

  const dup = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD } });
  assert.equal(dup.statusCode, 409, dup._body);
  assert.equal(dup.json().error.code, 'CONFLICT');
});

test('POST /auth/register rejects invalid JSON body with 400', async () => {
  // Hand-built req: raw invalid-JSON chunk (makeReq always JSON-encodes).
  const raw = Buffer.from('{not json');
  const req = {
    method: 'POST',
    url: '/auth/register',
    headers: {},
    socket: { remoteAddress: `10.0.1.${++ipCounter}` },
    on(event, cb) {
      if (event === 'data') cb(raw);
      else if (event === 'end') cb();
      return req;
    },
  };
  const res = makeRes();
  await handleAuth(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');
});

test('POST /auth/login returns a session; wrong password → 401', async () => {
  const email = uniqueEmail();
  await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD } });
  const ok = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(ok.statusCode, 200, ok._body);
  const session = ok.json();
  assert.equal(session.accessToken.split('.').length, 3, 'JWT has three segments');
  assert.ok(session.refreshToken.length > 20);
  assert.equal(session.user.email, email);
  assert.equal(typeof session.accessTokenTTLSec, 'number');

  const bad = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: 'wrong-password' } });
  assert.equal(bad.statusCode, 401);
});

test('POST /auth/refresh rotates the refresh token (old token dies on reuse)', async () => {
  const { refreshToken } = await registerAndLogin();

  const first = await callAuth({ method: 'POST', url: '/auth/refresh', body: { refreshToken } });
  assert.equal(first.statusCode, 200, first._body);
  const rotated = first.json().refreshToken;
  assert.ok(rotated && rotated !== refreshToken, 'refresh token rotated on use');

  // Replaying the already-rotated (now revoked) token is treated as a
  // theft signal by server/users.mjs#refreshSession: it does not just
  // reject the replayed token, it calls logoutAll() and revokes EVERY
  // refresh token for that user — including the sibling `rotated` token
  // minted one line above. This is documented, intentional behavior
  // (see the comment above the `if (row.revoked_at)` branch in
  // refreshSession), not a bug: once a revoked token is presented again,
  // the whole session family is nuked because we can no longer tell the
  // legitimate client from an attacker holding a stolen copy.
  const replay = await callAuth({ method: 'POST', url: '/auth/refresh', body: { refreshToken } });
  assert.equal(replay.statusCode, 401, 'replayed refresh token is rejected');

  // As a consequence, the freshly rotated sibling token is now dead too.
  const second = await callAuth({ method: 'POST', url: '/auth/refresh', body: { refreshToken: rotated } });
  assert.equal(second.statusCode, 401, 'reuse-detection revokes the whole session family, including the just-rotated sibling');
});

test('POST /auth/refresh rotation: rotated token works when the old one is never replayed', async () => {
  // Companion to the theft-detection test above: absent any replay of a
  // revoked token, the newly rotated token is fully usable. This isolates
  // "rotation issues a working token" from "replay nukes the family".
  const { refreshToken } = await registerAndLogin();

  const first = await callAuth({ method: 'POST', url: '/auth/refresh', body: { refreshToken } });
  assert.equal(first.statusCode, 200, first._body);
  const rotated = first.json().refreshToken;

  const second = await callAuth({ method: 'POST', url: '/auth/refresh', body: { refreshToken: rotated } });
  assert.equal(second.statusCode, 200, 'rotated token works when not preceded by a replay of its predecessor');
  assert.ok(second.json().refreshToken !== rotated, 'second rotation issues yet another new token');
});

test('POST /auth/register is rate-limited per IP (429 + Retry-After)', async () => {
  // authRegister bucket: capacity 3 per IP (server/rate-limit.mjs).
  const ip = '10.99.99.99';
  let got429 = null;
  for (let i = 0; i < 5; i++) {
    const res = await callAuth({ method: 'POST', url: '/auth/register', ip, body: { email: uniqueEmail(), password: PASSWORD } });
    if (res.statusCode === 429) { got429 = res; break; }
  }
  assert.ok(got429, 'expected a 429 within 5 attempts from one IP');
  assert.ok(Number(got429.headers['Retry-After']) > 0, 'Retry-After header present');
});

// ---- authenticated routes ------------------------------------------------
// handleAuth expects req.user pre-set by the authenticate middleware;
// we set it directly (unit boundary is the route handler, not the JWT).

test('authed routes reject requests without req.user (401 guard)', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/me' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');
});

test('GET /auth/me returns the profile; unknown id → 404', async () => {
  const { user } = await registerAndLogin();
  const ok = await callAuth({ method: 'GET', url: '/auth/me', user: { id: user.id } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().email, user.email);

  const gone = await callAuth({ method: 'GET', url: '/auth/me', user: { id: 'u_does_not_exist' } });
  assert.equal(gone.statusCode, 404);
});

test('POST /auth/logout revokes the access-token jti and all refresh tokens', async () => {
  const { user, refreshToken, accessToken } = await registerAndLogin();
  // Extract jti + exp from the real access token payload.
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
  assert.ok(payload.jti, 'access token carries a jti');

  const res = await callAuth({
    method: 'POST', url: '/auth/logout',
    user: { id: user.id, jti: payload.jti, tokenExp: payload.exp },
    body: {},
  });
  assert.equal(res.statusCode, 200, res._body);

  assert.equal(kb.isJtiRevoked(payload.jti), true, 'jti revoked');

  const refresh = await callAuth({ method: 'POST', url: '/auth/refresh', body: { refreshToken } });
  assert.equal(refresh.statusCode, 401, 'bearer-only logout revokes ALL refresh tokens (fail-safe)');
});

test('POST /auth/me/password changes the password and old creds stop working', async () => {
  const { user, email } = await registerAndLogin();
  const newPassword = 'EvenMoreCorrectStaple';
  const res = await callAuth({
    method: 'POST', url: '/auth/me/password',
    user: { id: user.id },
    body: { currentPassword: PASSWORD, newPassword },
  });
  assert.equal(res.statusCode, 200, res._body);

  const oldLogin = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(oldLogin.statusCode, 401);
  const newLogin = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: newPassword } });
  assert.equal(newLogin.statusCode, 200);
});

test('POST /auth/me/password with wrong current password → 401, audit-safe', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({
    method: 'POST', url: '/auth/me/password',
    user: { id: user.id },
    body: { currentPassword: 'nope', newPassword: 'WhateverItWontApply1' },
  });
  assert.equal(res.statusCode, 401);
});

test('vault secrets: set → list → delete roundtrip; unknown key refused', async () => {
  const { user } = await registerAndLogin();
  const u = { id: user.id };

  const set = await callAuth({ method: 'POST', url: '/auth/me/secrets', user: u, body: { key: 'github.token', value: 'ghp_test_value' } });
  assert.equal(set.statusCode, 200, set._body);

  let list = await callAuth({ method: 'GET', url: '/auth/me/secrets', user: u });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().secrets.some((s) => s.key === 'github.token'));

  const bad = await callAuth({ method: 'POST', url: '/auth/me/secrets', user: u, body: { key: 'evil.key', value: 'x' } });
  assert.equal(bad.statusCode, 400);

  // Empty value deletes.
  const del = await callAuth({ method: 'POST', url: '/auth/me/secrets', user: u, body: { key: 'github.token', value: null } });
  assert.equal(del.statusCode, 200);
  list = await callAuth({ method: 'GET', url: '/auth/me/secrets', user: u });
  assert.equal(list.json().secrets.length, 0);
});

test('prefs: PUT stores only allow-listed keys, GET returns them', async () => {
  const { user } = await registerAndLogin();
  const u = { id: user.id };
  // Allow-list is {language, bilingual} (kb/user.mjs ALLOWED_UI_PREF_KEYS).
  const put = await callAuth({ method: 'PUT', url: '/auth/me/prefs', user: u, body: { language: 'ja', bilingual: true, evil: 'dropped' } });
  assert.equal(put.statusCode, 200, put._body);
  const prefs = put.json().prefs;
  assert.equal(prefs.language, 'ja');
  assert.equal(prefs.bilingual, true);
  assert.equal(prefs.evil, undefined, 'unknown pref keys are silently dropped');

  const get = await callAuth({ method: 'GET', url: '/auth/me/prefs', user: u });
  assert.equal(get.json().prefs.language, 'ja');
});

test('unknown authed auth-route → 404 envelope', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/definitely-not-a-route', user: { id: user.id } });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, 'NOT_FOUND');
});

// ---- password-reset public-path regression ---------------------------------
// These routes are public but were missing from auth.mjs PUBLIC_PATHS, so a
// real unauthenticated client (no Authorization header) got 401 AUTH_REQUIRED
// from the authenticate() gate in server.mjs BEFORE ever reaching the handler.
// The tests above call handleAuth directly and so bypass that gate; these run
// authenticate() first, exactly as server.mjs does on every request.

// Mimics server.mjs: authenticate() runs on EVERY request before dispatch.
// Returns { authError } if the gate rejected the request (401 before the
// handler), otherwise runs the real handler and returns { res }.
async function callThroughGate(reqOpts) {
  const req = makeReq(reqOpts);
  const res = makeRes();
  try {
    authenticate(req);
  } catch (err) {
    return { authError: err };
  }
  await handleAuth(req, res, { db: kb.getDb(), logger: noopLogger, requestId: 'test-req' });
  return { res };
}

test('reset-request and reset-confirm are registered as public paths', () => {
  assert.equal(isPublicPath('POST', '/auth/reset-request'), true);
  assert.equal(isPublicPath('POST', '/auth/reset-confirm'), true);
});

test('authenticate() gate still rejects a non-public route with no bearer token', () => {
  // Control: proves the gate is real — a non-public path with no Authorization
  // header must throw AUTH_REQUIRED, so the passing reset tests below mean the
  // routes are genuinely exempt (not that the gate is inert).
  const req = makeReq({ method: 'GET', url: '/auth/me' });
  assert.throws(
    () => authenticate(req),
    (e) => e.code === 'AUTH_REQUIRED' && e.status === 401,
  );
});

test('POST /auth/reset-request passes the authenticate() gate with no Authorization header', async () => {
  const { authError, res } = await callThroughGate({
    method: 'POST', url: '/auth/reset-request', body: { email: uniqueEmail() },
  });
  assert.equal(authError, undefined, 'authenticate() must not reject the public reset-request route');
  assert.equal(res.statusCode, 200, res._body);
});

test('POST /auth/reset-confirm passes the authenticate() gate with no Authorization header', async () => {
  // Even with a bogus token the request must REACH the handler. The gate
  // never runs the handler when it rejects, so `authError === undefined`
  // is the signal that the route is exempt. (The handler then legitimately
  // rejects the bad token itself — that is a handler outcome, not the gate.)
  const { authError, res } = await callThroughGate({
    method: 'POST', url: '/auth/reset-confirm', body: { token: 'nope', newPassword: 'NewCorrectHorse1' },
  });
  assert.equal(authError, undefined, 'authenticate() must not reject the public reset-confirm route');
  assert.ok(res.ended, 'the reset-confirm handler must have run and produced a response');
});

test('password reset flow (request → confirm) works end-to-end through the real gate with no auth', async () => {
  const { email } = await registerAndLogin();

  const reqRes = await callThroughGate({ method: 'POST', url: '/auth/reset-request', body: { email } });
  assert.equal(reqRes.authError, undefined);
  assert.equal(reqRes.res.statusCode, 200, reqRes.res._body);
  const token = reqRes.res.json().token; // dev/test env returns the raw token
  assert.ok(token, 'reset-request should return a raw token in the test env');

  const newPassword = 'NewCorrectHorse1';
  const confirmRes = await callThroughGate({
    method: 'POST', url: '/auth/reset-confirm', body: { token, newPassword },
  });
  assert.equal(confirmRes.authError, undefined, 'authenticate() must not reject the public reset-confirm route');
  assert.equal(confirmRes.res.statusCode, 200, confirmRes.res._body);

  // The new password is usable; the old one is not.
  const good = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: newPassword } });
  assert.equal(good.statusCode, 200, good._body);
  const bad = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(bad.statusCode, 401, bad._body);
});
