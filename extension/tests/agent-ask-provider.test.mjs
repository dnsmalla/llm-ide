// Regression test for the iPhone "Chat" surface model error.
//
// POST /kb/agent/ask is the endpoint the Mac proxies the phone's main chat
// through. It used to call runClaude(prompt, { userId, images }) with NO
// provider/model, so a user who'd selected a non-Anthropic provider still got
// the Anthropic path → claude CLI fallback → "claude is not logged in".
//
// The handler now forwards body.provider/body.model. We assert that forwarding
// reaches runClaude's non-Anthropic branch WITHOUT mocking runClaude: DeepSeek
// has no CLI fallback and (in this test env) no stored key, so a forwarded
// `provider: 'deepseek'` deterministically throws
// "No API key configured for DeepSeek." (runtime.mjs deepseek branch). If the
// provider were dropped, the call would take the Anthropic path instead and
// never produce that error — so this test fails before the fix and passes after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-ask-provider-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const { handleKB } = await import('../routes/router.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    url,
    user: { id: userId },
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
    writeHead(code) { this.statusCode = code; },
    setHeader(k, v) { this.headers[k] = v; },
    write(chunk) { this._body += chunk; },
    end(chunk) { if (chunk) this._body += chunk; this.ended = true; },
  };
}

test('POST /kb/agent/ask forwards body.provider into runClaude (DeepSeek no-key branch)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `askprov-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'ap',
  });

  const req = makeReq({
    method: 'POST',
    url: '/kb/agent/ask',
    body: { message: 'hi', provider: 'deepseek', model: 'deepseek-chat' },
    userId: u.id,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);
  assert.equal(handled, true);
  // Reaching the DeepSeek no-key error proves the provider was forwarded all
  // the way into runClaude's non-Anthropic branch.
  assert.equal(res.statusCode, 500);
  const parsed = JSON.parse(res._body);
  assert.equal(parsed.error.code, 'AGENT_ASK_FAILED');
  assert.match(parsed.error.message, /DeepSeek/);
});

test('POST /kb/agent/ask still works without provider (backward compatible)', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `askprov2-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'ap2',
  });

  const req = makeReq({
    method: 'POST',
    url: '/kb/agent/ask',
    body: { message: 'hi' },
    userId: u.id,
  });
  const res = makeRes();
  const handled = await handleKB(req, res);
  assert.equal(handled, true);
  // No provider → Anthropic path. We don't assert success/failure here (it
  // depends on whether the test host has a Claude login/key), only that the
  // request was accepted and dispatched without a validation error.
  assert.ok(res.statusCode === 200 || res.statusCode === 500);
  const parsed = JSON.parse(res._body);
  assert.ok(parsed.reply != null || parsed.error != null);
});
