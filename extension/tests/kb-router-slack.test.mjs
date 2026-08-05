// HTTP-layer tests for GET /kb/slack/conversations and the slack.userToken
// vs slack.botToken resolution used by the existing /kb/slack/test|fetch
// handlers. Mirrors tests/kb-router-scip.test.mjs's setup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-router-slack-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../kb/router.mjs');
const users = await import('../server/users.mjs');
const { setSecret } = await import('../server/vault.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  db.getDb();
}
function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId },
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
  };
}

test('GET /kb/slack/conversations 400 SLACK_NO_TOKEN when neither token is saved', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `sc-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  const res = makeRes();
  await handleKB(makeReq({ method: 'GET', url: '/kb/slack/conversations', userId: u.id }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res._body).error.code, 'SLACK_NO_TOKEN');
});

test('GET /kb/slack/conversations prefers slack.userToken over slack.botToken', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `sc2-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(db.getDb(), u.id, 'slack.botToken', 'xoxb-old');
  setSecret(db.getDb(), u.id, 'slack.userToken', 'xoxp-new');

  const orig = global.fetch;
  const seenTokens = [];
  global.fetch = async (urlStr, init) => {
    seenTokens.push(init?.headers?.Authorization || '');
    return { ok: true, json: async () => ({ ok: true, channels: [], response_metadata: { next_cursor: '' } }) };
  };
  try {
    const res = makeRes();
    await handleKB(makeReq({ method: 'GET', url: '/kb/slack/conversations', userId: u.id }), res);
    assert.equal(res.statusCode, 200, res._body);
    assert.ok(seenTokens.some((h) => h.includes('xoxp-new')), 'must use slack.userToken, not slack.botToken, when both are present');
    assert.ok(!seenTokens.some((h) => h.includes('xoxb-old')), 'must not use slack.botToken when slack.userToken is present');
  } finally { global.fetch = orig; }
});

test('GET /kb/slack/conversations falls back to slack.botToken when no user token is saved', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `sc3-${Date.now()}@e.com`, password: 'CorrectHorseBattery', displayName: 'v' });
  setSecret(db.getDb(), u.id, 'slack.botToken', 'xoxb-only');

  const orig = global.fetch;
  const seenTokens = [];
  global.fetch = async (urlStr, init) => {
    seenTokens.push(init?.headers?.Authorization || '');
    return { ok: true, json: async () => ({ ok: true, channels: [{ id: 'C9', name: 'legacy' }], response_metadata: { next_cursor: '' } }) };
  };
  try {
    const res = makeRes();
    await handleKB(makeReq({ method: 'GET', url: '/kb/slack/conversations', userId: u.id }), res);
    assert.equal(res.statusCode, 200, res._body);
    assert.deepEqual(JSON.parse(res._body).channels, [{ id: 'C9', name: 'legacy' }]);
    assert.ok(seenTokens.some((h) => h.includes('xoxb-only')));
  } finally { global.fetch = orig; }
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});
