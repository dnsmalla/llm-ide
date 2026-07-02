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
