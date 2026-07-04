// HTTP-level tests for the /auth/google/{start,callback,status} routes in
// server/auth-routes.mjs. Follows the same req/res double pattern as
// auth-routes.test.mjs (makeReq/makeRes, temp DB set up before import).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
// Avoid polluting the real server.log when this suite runs alongside others.
process.env.LLMIDE_LOG_FILE = 'none';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_google-oauth-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');
const { getSecret } = await import('../server/vault.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user, headers = {}, ip }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    headers,
    user,
    socket: { remoteAddress: ip || `10.10.0.${++ipCounter}` },
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
function uniqueEmail() { return `google-oauth-routes-${Date.now()}-${++emailCounter}@example.com`; }
const PASSWORD = 'CorrectHorseBattery';

async function registerAndLogin() {
  const email = uniqueEmail();
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD, displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login._body);
  return { email, ...login.json() };
}

// ---- POST /auth/google/start (authed) ----------------------------------

test('POST /auth/google/start requires auth', async () => {
  const res = await callAuth({ method: 'POST', url: '/auth/google/start', body: { clientId: 'x', clientSecret: 'y' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');
});

test('POST /auth/google/start validates clientId/clientSecret', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/google/start', user: { id: user.id }, body: { clientId: '', clientSecret: '' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');
});

test('POST /auth/google/start returns authUrl+state and persists clientSecret to the vault', async () => {
  const { user } = await registerAndLogin();
  const clientId = 'test-client-id.apps.googleusercontent.com';
  const clientSecret = 'test-client-secret-abc123';
  const res = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: user.id },
    body: { clientId, clientSecret },
  });
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.ok(typeof body.state === 'string' && body.state.length > 10, 'state issued');
  assert.ok(body.authUrl.includes(encodeURIComponent(clientId)) || body.authUrl.includes(clientId), 'authUrl carries the clientId');
  assert.ok(body.authUrl.includes('code_challenge='), 'authUrl carries a PKCE code_challenge');

  // Side effect: clientId/clientSecret are persisted to the vault for this user.
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.clientId'), clientId);
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.clientSecret'), clientSecret);
});

// ---- GET /auth/google/callback (public) --------------------------------

test('GET /auth/google/callback with unknown state → error HTML, no throw', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/google/callback?code=abc&state=does-not-exist' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'] || '', /text\/html/);
  assert.match(res._body, /expired|start again/i);
});

test('GET /auth/google/callback?error=... marks a known state as cancelled', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: user.id },
    body: { clientId: 'cid', clientSecret: 'csecret' },
  });
  const { state } = start.json();

  const cb = await callAuth({ method: 'GET', url: `/auth/google/callback?error=access_denied&state=${state}` });
  assert.equal(cb.statusCode, 200);
  assert.match(cb._body, /cancelled/i);

  const status = await callAuth({ method: 'GET', url: `/auth/google/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, 'error');
});

test('full flow: start -> callback (token exchange + userinfo stubbed) -> status complete with email', async () => {
  const { user } = await registerAndLogin();
  const clientId = 'flow-client-id';
  const clientSecret = 'flow-client-secret';
  const start = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: user.id },
    body: { clientId, clientSecret },
  });
  assert.equal(start.statusCode, 200, start._body);
  const { state } = start.json();

  const originalFetch = global.fetch;
  const email = 'flow-user@example.com';
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return {
        ok: true,
        json: async () => ({ access_token: 'access-tok-123', refresh_token: 'refresh-tok-456', expires_in: 3600 }),
      };
    }
    if (u.includes('openidconnect.googleapis.com/v1/userinfo')) {
      return { ok: true, json: async () => ({ email }) };
    }
    throw new Error(`Unexpected fetch to ${u}`);
  };

  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/google/callback?code=auth-code-789&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /Signed in to Google/i);
  } finally {
    global.fetch = originalFetch;
  }

  // Side effect: refreshToken persisted to vault.
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.refreshToken'), 'refresh-tok-456');

  // GET /auth/google/status (authed) reflects completion + email.
  const status = await callAuth({ method: 'GET', url: `/auth/google/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200, status._body);
  const statusBody = status.json();
  assert.equal(statusBody.status, 'complete');
  assert.equal(statusBody.email, email);
});

test('GET /auth/google/callback rejects a second callback that reuses an already-completed state', async () => {
  const { user } = await registerAndLogin();
  const clientId = 'replay-client-id';
  const clientSecret = 'replay-client-secret';
  const start = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: user.id },
    body: { clientId, clientSecret },
  });
  assert.equal(start.statusCode, 200, start._body);
  const { state } = start.json();

  const originalFetch = global.fetch;
  let tokenExchangeCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      tokenExchangeCalls++;
      return {
        ok: true,
        json: async () => ({ access_token: 'access-tok-replay', refresh_token: 'refresh-tok-replay', expires_in: 3600 }),
      };
    }
    if (u.includes('openidconnect.googleapis.com/v1/userinfo')) {
      return { ok: true, json: async () => ({ email: 'replay-user@example.com' }) };
    }
    throw new Error(`Unexpected fetch to ${u}`);
  };

  try {
    // First callback completes normally.
    const cb1 = await callAuth({ method: 'GET', url: `/auth/google/callback?code=auth-code-first&state=${state}` });
    assert.equal(cb1.statusCode, 200, cb1._body);
    assert.match(cb1._body, /Signed in to Google/i);
    assert.equal(tokenExchangeCalls, 1);

    // Second callback reuses the same (now-complete) state with a fresh code.
    const cb2 = await callAuth({ method: 'GET', url: `/auth/google/callback?code=auth-code-second&state=${state}` });
    assert.equal(cb2.statusCode, 200, cb2._body);
    assert.match(cb2._body, /already been used/i);
    // exchangeCode must NOT have run a second time.
    assert.equal(tokenExchangeCalls, 1, 'token exchange must not be re-run for a non-pending state');
  } finally {
    global.fetch = originalFetch;
  }

  // The vault refresh token from the first (legitimate) exchange is unchanged.
  assert.equal(getSecret(kb.getDb(), user.id, 'google.email.refreshToken'), 'refresh-tok-replay');
});

test('GET /auth/google/callback escapes HTML in an upstream error message', async () => {
  const { user } = await registerAndLogin();
  const clientId = 'xss-client-id';
  const clientSecret = 'xss-client-secret';
  const start = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: user.id },
    body: { clientId, clientSecret },
  });
  assert.equal(start.statusCode, 200, start._body);
  const { state } = start.json();

  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      throw new Error('bad request <script>alert(1)</script>');
    }
    throw new Error(`Unexpected fetch to ${u}`);
  };

  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/google/callback?code=auth-code-xss&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.ok(cb._body.includes('&lt;script&gt;'), 'script tag must be escaped');
    assert.ok(!cb._body.includes('<script>alert'), 'raw script tag must not survive into the HTML response');
  } finally {
    global.fetch = originalFetch;
  }
});

// ---- GET /auth/google/status (authed) -----------------------------------

test('GET /auth/google/status requires auth', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/google/status?state=whatever' });
  assert.equal(res.statusCode, 401);
});

test('GET /auth/google/status for an unknown state → {status:"unknown"}', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'GET', url: '/auth/google/status?state=nope-not-real', user: { id: user.id } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'unknown');
});

test('GET /auth/google/status forbids reading another user\'s pending state', async () => {
  const { user: owner } = await registerAndLogin();
  const { user: intruder } = await registerAndLogin();
  const start = await callAuth({
    method: 'POST', url: '/auth/google/start', user: { id: owner.id },
    body: { clientId: 'cid', clientSecret: 'csecret' },
  });
  const { state } = start.json();

  const res = await callAuth({ method: 'GET', url: `/auth/google/status?state=${state}`, user: { id: intruder.id } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});
