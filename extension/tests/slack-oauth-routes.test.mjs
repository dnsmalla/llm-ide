// HTTP-level tests for the /auth/slack/{start,callback,status} routes in
// server/auth-routes.mjs, with the hosted Slack App credentials configured.
// Follows the same req/res double pattern as google-oauth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
process.env.LLMIDE_SLACK_CLIENT_ID = 'test-slack-client-id';
process.env.LLMIDE_SLACK_CLIENT_SECRET = 'test-slack-client-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_slack-oauth-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');
const { getSecret } = await import('../server/vault.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, headers: {}, user,
    socket: { remoteAddress: `10.30.0.${++ipCounter}` },
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
    statusCode: 200, headers: {}, _body: '', headersSent: false,
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
function uniqueEmail() { return `slack-oauth-routes-${Date.now()}-${++emailCounter}@example.com`; }
const PASSWORD = 'CorrectHorseBattery';

async function registerAndLogin() {
  const email = uniqueEmail();
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD, displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login._body);
  return { email, ...login.json() };
}

function stubSlackFetch({ tokenOk = true } = {}) {
  const orig = global.fetch;
  let tokenExchangeCalls = 0;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('oauth.v2.access')) {
      tokenExchangeCalls++;
      if (!tokenOk) return { ok: true, json: async () => ({ ok: false, error: 'invalid_code' }) };
      return { ok: true, json: async () => ({ ok: true, authed_user: { access_token: 'xoxp-flow-token' }, team: { name: 'Acme' } }) };
    }
    throw new Error(`Unexpected fetch to ${u}`);
  };
  return { restore: () => { global.fetch = orig; }, callCount: () => tokenExchangeCalls };
}

// ---- POST /auth/slack/start (authed) -----------------------------------

test('POST /auth/slack/start requires auth', async () => {
  const res = await callAuth({ method: 'POST', url: '/auth/slack/start' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error.code, 'AUTH_REQUIRED');
});

test('POST /auth/slack/start returns authUrl+state carrying the configured client id, no client secret', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  assert.equal(res.statusCode, 200, res._body);
  const body = res.json();
  assert.ok(typeof body.state === 'string' && body.state.length > 10, 'state issued');
  assert.ok(body.authUrl.includes('client_id=test-slack-client-id'));
  assert.ok(!body.authUrl.includes('test-slack-client-secret'), 'client secret must never appear in the authUrl');
});

// ---- GET /auth/slack/callback (public) ---------------------------------

test('GET /auth/slack/callback with unknown state → error HTML, no throw', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/slack/callback?code=abc&state=does-not-exist' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'] || '', /text\/html/);
  assert.match(res._body, /expired|start again/i);
});

test('GET /auth/slack/callback?error=... marks a known state as cancelled', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?error=access_denied&state=${state}` });
  assert.equal(cb.statusCode, 200);
  assert.match(cb._body, /cancelled/i);

  const status = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().status, 'error');
});

test('full flow: start -> callback (token exchange) -> status complete with teamName', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  assert.equal(start.statusCode, 200, start._body);
  const { state } = start.json();

  const stub = stubSlackFetch();
  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=auth-code-789&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /Connected to Slack/i);
  } finally { stub.restore(); }

  // Side effect: user token persisted to vault under slack.userToken.
  assert.equal(getSecret(kb.getDb(), user.id, 'slack.userToken'), 'xoxp-flow-token');

  const status = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: user.id } });
  assert.equal(status.statusCode, 200, status._body);
  const statusBody = status.json();
  assert.equal(statusBody.status, 'complete');
  assert.equal(statusBody.teamName, 'Acme');
});

test('GET /auth/slack/callback rejects a second callback that reuses an already-completed state', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const stub = stubSlackFetch();
  try {
    const cb1 = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=first&state=${state}` });
    assert.equal(cb1.statusCode, 200, cb1._body);
    assert.match(cb1._body, /Connected to Slack/i);
    assert.equal(stub.callCount(), 1);

    const cb2 = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=second&state=${state}` });
    assert.equal(cb2.statusCode, 200, cb2._body);
    assert.match(cb2._body, /already been used/i);
    assert.equal(stub.callCount(), 1, 'token exchange must not be re-run for a non-pending state');
  } finally { stub.restore(); }
});

test('GET /auth/slack/callback surfaces a clean error and redacts the client secret on exchange failure', async () => {
  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  const { state } = start.json();

  const stub = stubSlackFetch({ tokenOk: false });
  try {
    const cb = await callAuth({ method: 'GET', url: `/auth/slack/callback?code=bad&state=${state}` });
    assert.equal(cb.statusCode, 200, cb._body);
    assert.match(cb._body, /failed/i);
    assert.ok(!cb._body.includes('test-slack-client-secret'), 'client secret must never leak into the error HTML');
  } finally { stub.restore(); }
});

// ---- GET /auth/slack/status (authed) -----------------------------------

test('GET /auth/slack/status requires auth', async () => {
  const res = await callAuth({ method: 'GET', url: '/auth/slack/status?state=whatever' });
  assert.equal(res.statusCode, 401);
});

test('GET /auth/slack/status for an unknown state → {status:"unknown"}', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'GET', url: '/auth/slack/status?state=nope-not-real', user: { id: user.id } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'unknown');
});

test('GET /auth/slack/status forbids reading another user\'s pending state', async () => {
  const { user: owner } = await registerAndLogin();
  const { user: intruder } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: owner.id } });
  const { state } = start.json();

  const res = await callAuth({ method: 'GET', url: `/auth/slack/status?state=${state}`, user: { id: intruder.id } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'FORBIDDEN');
});
