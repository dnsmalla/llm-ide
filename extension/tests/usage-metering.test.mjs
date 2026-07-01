// Integration: confirms that dispatching a model call through runClaude /
// completeViaApi actually writes to the usage ledger, captures rate-limit
// headers, and performs an in-request reactive fallback on a 429 quota error.
// (usage.mjs is unit-tested separately; this pins the wiring inside dispatch.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_usage-metering-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const db = await import('../kb/db.mjs');
const vault = await import('../server/vault.mjs');
const users = await import('../server/users.mjs');
const usage = await import('../kb/usage.mjs');
const { runClaude } = await import('../agents/runtime.mjs');

function freshUser() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `meter-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery', displayName: 'm',
  }).id;
}
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(String(url), opts);
  return () => { globalThis.fetch = original; };
}

test('runClaude records token usage + rate-limit headers (Anthropic path)', async () => {
  const userId = freshUser();
  vault.setSecret(db.getDb(), userId, 'claude.apiKey', 'sk-anthropic-test');
  const restore = mockFetch(async () => ({
    ok: true, status: 200,
    headers: new Map([
      ['anthropic-ratelimit-tokens-limit', '100000'],
      ['anthropic-ratelimit-tokens-remaining', '99985'],
    ]),
    json: async () => ({ content: [{ text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } }),
    text: async () => '{}',
  }));
  try {
    const out = await runClaude('hi', { userId, model: 'claude-sonnet-4-6', endpoint: '/test' });
    assert.equal(out, 'ok');
  } finally { restore(); }

  assert.equal(usage.usedForModel(db.getDb(), userId, 'anthropic', 'claude-sonnet-4-6', 'tokens', 'daily'), 15);
  assert.equal(usage.usedForModel(db.getDb(), userId, 'anthropic', 'claude-sonnet-4-6', 'runs', 'daily'), 1);
  const rl = usage.getRateLimits(userId, 'anthropic');
  assert.equal(rl.tokens.remaining, 99985);
});

test('completeViaApi reactively falls back to the next model on a 429 quota error', async () => {
  const userId = freshUser();
  vault.setSecret(db.getDb(), userId, 'openai.apiKey', 'sk-openai-test');
  let call = 0;
  const restore = mockFetch(async () => {
    call += 1;
    if (call === 1) {
      // First model (gpt-4o): non-transient quota 429.
      return { ok: false, status: 429, headers: new Map(),
               text: async () => '{"error":{"message":"insufficient_quota"}}' };
    }
    // Second model (the fallback) succeeds.
    return { ok: true, status: 200, headers: new Map(),
             json: async () => ({ choices: [{ message: { content: 'fallback-reply' } }] }),
             text: async () => '{}' };
  });
  try {
    const out = await runClaude('hi', { userId, model: 'gpt-4o' });
    assert.equal(out, 'fallback-reply');
    assert.equal(call, 2, 'should have retried once on the next model');
  } finally { restore(); }

  // gpt-4o was flagged exhausted; usage recorded against the fallback model.
  assert.equal(usage.usedForModel(db.getDb(), userId, 'openai', 'gpt-4o-mini', 'runs', 'daily'), 1);
});
