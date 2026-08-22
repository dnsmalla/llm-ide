// HTTP-level tests for /auth/mcp-connector/{start,callback,status}.
// The connector is pointed at the hermetic fixture via LLMIDE_MCP_MIRO_URL,
// which mcpConnectorDef() re-reads on every call. Follows the same req/res
// double pattern as slack-oauth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_mcp-connector-oauth-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const { handleAuth } = await import('../server/auth-routes.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, user }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, headers: {}, user,
    socket: { remoteAddress: `10.31.0.${++ipCounter}` },
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
function uniqueEmail() { return `mcp-connector-oauth-routes-${Date.now()}-${++emailCounter}@example.com`; }
const PASSWORD = 'CorrectHorseBattery';

async function registerAndLogin() {
  const email = uniqueEmail();
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD, displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login._body);
  return { email, ...login.json() };
}

const { startFakeMcpServer } = await import('./fixtures/fake-mcp-oauth-server.mjs');
const { isAuthRoute } = await import('../server/auth-routes.mjs');
const { isPublicPath } = await import('../server/auth.mjs');

test('the three routes are allow-listed and only the callback is public', () => {
  for (const p of ['/auth/mcp-connector/start', '/auth/mcp-connector/callback', '/auth/mcp-connector/status']) {
    assert.ok(isAuthRoute(p), `${p} must dispatch to handleAuth`);
  }
  assert.ok(isAuthRoute('/auth/mcp-connector/status?id=miro'), 'query strings must not break dispatch');
  // The OAuth redirect arrives from a browser with no bearer token.
  assert.ok(isPublicPath('GET', '/auth/mcp-connector/callback?code=x&state=y'));
  assert.ok(!isPublicPath('POST', '/auth/mcp-connector/start'));
  assert.ok(!isPublicPath('GET', '/auth/mcp-connector/status?id=miro'));
});

test('start rejects an unknown connector id', async () => {
  const { user } = await registerAndLogin();
  for (const body of [{ id: 'nope' }, { id: 'gdrive' }, {}]) {
    const r = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body, user });
    assert.equal(r.statusCode, 400, r._body);
    assert.equal(r.json().error.code, 'VALIDATION_FAILED');
  }
});

test('full connect loop: start → callback → status', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user } = await registerAndLogin();

  // Not connected yet.
  const s0 = await callAuth({ method: 'GET', url: '/auth/mcp-connector/status?id=miro', user });
  assert.equal(s0.statusCode, 200, s0._body);
  assert.equal(s0.json().connected, false);

  // Start — the URL comes back to us because we cannot redirect server-side.
  const start = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  assert.equal(start.statusCode, 200, start._body);
  const { authUrl, state } = start.json();
  assert.ok(state);
  assert.equal(new URL(authUrl).origin, fake.origin);
  assert.equal(new URL(authUrl).searchParams.get('state'), state);

  // Poll while the tab is open.
  const pending = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user });
  assert.equal(pending.json().status, 'pending');
  assert.equal(pending.json().connected, false);

  // The browser consents and is redirected to our public callback.
  const { code, state: echoed } = await fake.authorize(authUrl);
  assert.equal(echoed, state);
  const cb = await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });
  assert.equal(cb.statusCode, 200, cb._body);
  assert.match(cb._body, /Connected to Miro/);
  assert.doesNotMatch(cb._body, new RegExp(code), 'the callback must not echo the authorization code');

  // Terminal status, single use.
  const done = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user });
  assert.equal(done.json().status, 'complete');
  assert.equal(done.json().connected, true);
  assert.equal(done.json().account, 'fake-miro');
  const reread = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user });
  assert.equal(reread.json().status, 'unknown', 'terminal status is consumed once');
  assert.equal(reread.json().connected, true, 'but connectedness still reads the vault');
});

test('start reports alreadyConnected for a live connection', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user } = await registerAndLogin();
  const s1 = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  const { code, state } = await fake.authorize(s1.json().authUrl);
  await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });

  const s2 = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  assert.equal(s2.statusCode, 200, s2._body);
  assert.equal(s2.json().alreadyConnected, true);
  assert.equal(s2.json().authUrl, undefined);
});

test('the callback refuses replayed, unknown and cancelled states', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  const { authUrl, state } = start.json();
  const { code } = await fake.authorize(authUrl);

  const first = await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });
  assert.match(first._body, /Connected to Miro/);

  const replay = await callAuth({ method: 'GET', url: `/auth/mcp-connector/callback?code=${code}&state=${state}` });
  assert.match(replay._body, /already been used/);

  const unknown = await callAuth({ method: 'GET', url: '/auth/mcp-connector/callback?code=x&state=not-a-state' });
  assert.match(unknown._body, /expired/);

  const s2 = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  const cancelled = await callAuth({
    method: 'GET', url: `/auth/mcp-connector/callback?error=access_denied&state=${s2.json().state}`,
  });
  assert.match(cancelled._body, /cancelled/);
});

test('status refuses to leak another user’s flow', async (t) => {
  const fake = await startFakeMcpServer();
  process.env.LLMIDE_MCP_MIRO_URL = fake.url;
  t.after(async () => { delete process.env.LLMIDE_MCP_MIRO_URL; await fake.close(); });

  const { user: owner } = await registerAndLogin();
  const { user: other } = await registerAndLogin();
  const start = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user: owner });
  const { state } = start.json();

  const r = await callAuth({ method: 'GET', url: `/auth/mcp-connector/status?id=miro&state=${state}`, user: other });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error.code, 'FORBIDDEN');
});

test('status rejects an unknown connector id', async () => {
  const { user } = await registerAndLogin();
  const r = await callAuth({ method: 'GET', url: '/auth/mcp-connector/status?id=nope', user });
  assert.equal(r.statusCode, 400);
});

test('start surfaces an unreachable server as 502, not a crash', async (t) => {
  const fake = await startFakeMcpServer();
  const deadUrl = fake.url;
  await fake.close();                       // port is now closed
  process.env.LLMIDE_MCP_MIRO_URL = deadUrl;
  t.after(() => { delete process.env.LLMIDE_MCP_MIRO_URL; });

  const { user } = await registerAndLogin();
  const r = await callAuth({ method: 'POST', url: '/auth/mcp-connector/start', body: { id: 'miro' }, user });
  assert.equal(r.statusCode, 502, r._body);
  assert.equal(r.json().error.code, 'MCP_AUTH_START_FAILED');
});
