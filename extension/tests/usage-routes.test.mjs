// Tests for the /kb/usage/* HTTP routes (limits, summary, resolve, record).
// Same req/res double pattern as activity-routes.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_usage-routes-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId }, _chunks: chunks,
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
    statusCode: 200, headers: {}, _body: '',
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
    json() { return JSON.parse(this._body); },
  };
}

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
async function newUser(tag) {
  const { registerUser } = await import('../server/users.mjs');
  return registerUser(db.getDb(), { email: `usage-${tag}-${Date.now()}@ex.com`, password: 'CorrectHorseBattery', displayName: tag }).id;
}

test('GET /kb/usage/limits returns the built-in chains by default', async () => {
  resetDb();
  const userId = await newUser('limits');
  const res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/usage/limits', userId }), res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.chains.anthropic.length >= 3);
  assert.equal(body.chains.anthropic[0].model, 'claude-opus-4-8');
});

test('PUT /kb/usage/limits saves caps; GET reflects them', async () => {
  resetDb();
  const userId = await newUser('put');
  let res = makeRes();
  await handleKB(makeReq({
    method: 'PUT', url: '/kb/usage/limits', userId,
    body: { chains: { anthropic: [
      { model: 'claude-opus-4-8', priority: 0, limit_value: 25, unit: 'runs', window_kind: 'daily', threshold_pct: 75 },
    ] } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/usage/limits?provider=anthropic', userId }), res);
  const opus = res.json().chains.anthropic.find((m) => m.model === 'claude-opus-4-8');
  assert.equal(opus.limit_value, 25);
  assert.equal(opus.threshold_pct, 75);
});

test('PUT /kb/usage/limits rejects a missing chains object with 400', async () => {
  resetDb();
  const userId = await newUser('badput');
  const res = makeRes();
  await handleKB(makeReq({ method: 'PUT', url: '/kb/usage/limits', userId, body: {} }), res);
  assert.equal(res.statusCode, 400);
});

test('POST /kb/usage/record then GET /kb/usage/summary shows the usage', async () => {
  resetDb();
  const userId = await newUser('rec');
  let res = makeRes();
  await handleKB(makeReq({
    method: 'POST', url: '/kb/usage/record', userId,
    body: { provider: 'anthropic', model: 'claude-opus-4-8', source: 'auto-task', endpoint: 'auto-task:reviewCode' },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);

  res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/usage/summary?provider=anthropic', userId }), res);
  const opus = res.json().providers.anthropic.models.find((m) => m.model === 'claude-opus-4-8');
  assert.equal(opus.used, 1);
});

test('POST /kb/usage/record rejects missing provider/model with 400', async () => {
  resetDb();
  const userId = await newUser('badrec');
  const res = makeRes();
  await handleKB(makeReq({ method: 'POST', url: '/kb/usage/record', userId, body: { provider: 'anthropic' } }), res);
  assert.equal(res.statusCode, 400);
});

test('GET /kb/usage/resolve returns the active model; switches after caps fill', async () => {
  resetDb();
  const userId = await newUser('resolve');
  // Cap opus low so two runs exhaust its 90% threshold.
  await handleKB(makeReq({
    method: 'PUT', url: '/kb/usage/limits', userId,
    body: { chains: { anthropic: [
      { model: 'claude-opus-4-8',   priority: 0, limit_value: 2, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
      { model: 'claude-sonnet-4-6', priority: 1, limit_value: 100, unit: 'runs', window_kind: 'daily', threshold_pct: 90 },
    ] } },
  }), makeRes());

  let res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/usage/resolve?provider=anthropic', userId }), res);
  assert.equal(res.json().model, 'claude-opus-4-8'); // healthy

  for (let i = 0; i < 2; i++) {
    await handleKB(makeReq({
      method: 'POST', url: '/kb/usage/record', userId,
      body: { provider: 'anthropic', model: 'claude-opus-4-8' },
    }), makeRes());
  }
  res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/usage/resolve?provider=anthropic', userId }), res);
  assert.equal(res.json().model, 'claude-sonnet-4-6'); // switched
});

test('GET /kb/usage/resolve rejects an unknown provider with 400', async () => {
  resetDb();
  const userId = await newUser('badresolve');
  const res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/usage/resolve?provider=nope', userId }), res);
  assert.equal(res.statusCode, 400);
});
