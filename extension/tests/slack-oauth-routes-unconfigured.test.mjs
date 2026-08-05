// HTTP-level test for /auth/slack/start when the server has no hosted Slack
// App credentials configured. Kept in its own file/process — config.mjs
// freezes its config object at first import, so this env-var state can't
// coexist with the "configured" tests in slack-oauth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_SLACK_CLIENT_ID;
delete process.env.LLMIDE_SLACK_CLIENT_SECRET;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_slack-oauth-routes-unconfigured-test.db');
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
    socket: { remoteAddress: `10.20.0.${++ipCounter}` },
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

async function registerAndLogin() {
  const email = `slack-unconfigured-${Date.now()}@example.com`;
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: 'CorrectHorseBattery', displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: 'CorrectHorseBattery' } });
  assert.equal(login.statusCode, 200, login._body);
  return { ...login.json() };
}

test('POST /auth/slack/start returns 503 CONFIG_MISSING when the server has no Slack App credentials', async () => {
  const { user } = await registerAndLogin();
  const res = await callAuth({ method: 'POST', url: '/auth/slack/start', user: { id: user.id } });
  assert.equal(res.statusCode, 503, res._body);
  assert.equal(res.json().error.code, 'CONFIG_MISSING');
});
