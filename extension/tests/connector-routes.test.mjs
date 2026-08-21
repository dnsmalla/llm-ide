// HTTP-level tests for the /auth/me/connectors route family.
// Same req/res double pattern as auth-routes.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_connector-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

// Fresh plugin dir per run → connector-state.json lands in its parent
// temp dir, keeping pre-selection state clean for every execution.
const stateRoot = fs.mkdtempSync(path.join(tmpdir(), 'connector-routes-'));
process.env.LLMIDE_PLUGIN_DIR = path.join(stateRoot, 'plugins');
fs.mkdirSync(process.env.LLMIDE_PLUGIN_DIR, { recursive: true });
const repoRootFixture = path.join(__dirname, '_connector-routes-repo-root-fixture');
process.env.LLMIDE_REPO_ROOT = repoRootFixture;
fs.rmSync(repoRootFixture, { recursive: true, force: true });
fs.mkdirSync(repoRootFixture, { recursive: true });

const kb = await import('../kb/db.mjs');
const { handleAuth, isAuthRoute } = await import('../server/auth-routes.mjs');

const noopLogger = { info() {}, warn() {}, error() {}, child() { return this; } };

let ipCounter = 0;
function makeReq({ method, url, body, rawBody, user, headers = {}, ip }) {
  const chunks = rawBody != null ? [rawBody] : body == null ? [] : [Buffer.from(JSON.stringify(body))];
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
function uniqueEmail() { return `connector-routes-${Date.now()}-${++emailCounter}@example.com`; }
const PASSWORD = 'CorrectHorseBattery';

async function registerAndLogin() {
  const email = uniqueEmail();
  const reg = await callAuth({ method: 'POST', url: '/auth/register', body: { email, password: PASSWORD, displayName: 'T' } });
  assert.equal(reg.statusCode, 201, reg._body);
  const login = await callAuth({ method: 'POST', url: '/auth/login', body: { email, password: PASSWORD } });
  assert.equal(login.statusCode, 200, login._body);
  return { email, ...login.json() };
}

test('connector paths are recognised auth routes', () => {
  assert.equal(isAuthRoute('/auth/me/connectors'), true);
  assert.equal(isAuthRoute('/auth/me/connectors/catalog'), true);
  assert.equal(isAuthRoute('/auth/me/connectors/add'), true);
  assert.equal(isAuthRoute('/auth/me/connectors/slack'), true);
});

test('connector routes: pre-selection, list, catalog, add, remove', async () => {
  const { user } = await registerAndLogin();

  // Pre-selection: box + slack on first read.
  const list0 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user });
  assert.equal(list0.statusCode, 200, list0._body);
  assert.deepEqual(list0.json().connectors.map((c) => c.id).sort(), ['box', 'slack']);

  // Catalog: all five, with the selected flag computed per user.
  const cat = await callAuth({ method: 'GET', url: '/auth/me/connectors/catalog', user });
  assert.equal(cat.statusCode, 200, cat._body);
  const entries = cat.json().catalog;
  assert.equal(entries.length, 5);
  assert.equal(entries.find((e) => e.id === 'slack').selected, true);
  assert.equal(entries.find((e) => e.id === 'gdrive').selected, false);
  for (const e of entries) {
    assert.equal(typeof e.name, 'string');
    assert.equal(typeof e.pipelineReady, 'boolean');
  }

  // Add + duplicate add is idempotent.
  const add = await callAuth({ method: 'POST', url: '/auth/me/connectors/add', body: { id: 'miro' }, user });
  assert.equal(add.statusCode, 200, add._body);
  const addAgain = await callAuth({ method: 'POST', url: '/auth/me/connectors/add', body: { id: 'miro' }, user });
  assert.equal(addAgain.statusCode, 200, addAgain._body);
  const list1 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user });
  assert.deepEqual(list1.json().connectors.map((c) => c.id).sort(), ['box', 'miro', 'slack']);

  // Unknown id → 400.
  const bad = await callAuth({ method: 'POST', url: '/auth/me/connectors/add', body: { id: 'nope' }, user });
  assert.equal(bad.statusCode, 400);

  // Remove slack → disappears from the list.
  const del = await callAuth({ method: 'DELETE', url: '/auth/me/connectors/slack', user });
  assert.equal(del.statusCode, 200, del._body);
  const list2 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user });
  assert.deepEqual(list2.json().connectors.map((c) => c.id).sort(), ['box', 'miro']);

  // Selections are per-user: a second user still sees only the pre-selection.
  const { user: user2 } = await registerAndLogin();
  const list3 = await callAuth({ method: 'GET', url: '/auth/me/connectors', user: user2 });
  assert.deepEqual(list3.json().connectors.map((c) => c.id).sort(), ['box', 'slack']);
});
