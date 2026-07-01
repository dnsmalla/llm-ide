// runClaude provider routing (integration). The provider adapters are
// unit-tested in providers.test.mjs; this pins that runClaude itself sends
// a non-Anthropic model to the right provider API (not the Anthropic
// endpoint or the claude CLI), and that a Claude model still goes to
// Anthropic. Credentials come from the user's vault; fetch is mocked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_runtime-routing-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

// No operator keys — force the user-scoped vault key path.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;

const db = await import('../kb/db.mjs');
const vault = await import('../server/vault.mjs');
const users = await import('../server/users.mjs');
const { runClaude } = await import('../agents/runtime.mjs');

function freshUser() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  return users.registerUser(db.getDb(), {
    email: `routing-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'r',
  }).id;
}

function mockFetchCapturing(handler) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, opts) => { urls.push(String(url)); return handler(url, opts); };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

test('runClaude routes an OpenAI model to the OpenAI API (not Anthropic/CLI)', async () => {
  const userId = freshUser();
  vault.setSecret(db.getDb(), userId, 'openai.apiKey', 'sk-openai-test');

  const m = mockFetchCapturing(async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: 'openai-reply' } }] }),
    text: async () => '{}',
  }));
  try {
    const out = await runClaude('hi', { userId, model: 'gpt-4o' });
    assert.equal(out, 'openai-reply');
    assert.equal(m.urls.length, 1);
    assert.match(m.urls[0], /api\.openai\.com/);
  } finally { m.restore(); }
});

test('runClaude routes a Claude model to the Anthropic API', async () => {
  const userId = freshUser();
  vault.setSecret(db.getDb(), userId, 'claude.apiKey', 'sk-anthropic-test');

  const m = mockFetchCapturing(async () => ({
    ok: true, status: 200,
    json: async () => ({ content: [{ text: 'claude-reply' }] }),
    text: async () => '{}',
  }));
  try {
    const out = await runClaude('hi', { userId, model: 'claude-sonnet-4-6' });
    assert.equal(out, 'claude-reply');
    assert.match(m.urls[0], /api\.anthropic\.com/);
  } finally { m.restore(); }
});

test('runClaude routes a Gemini model to the Google API', async () => {
  const userId = freshUser();
  vault.setSecret(db.getDb(), userId, 'google.apiKey', 'g-test');

  const m = mockFetchCapturing(async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini-reply' }] } }] }),
    text: async () => '{}',
  }));
  try {
    const out = await runClaude('hi', { userId, model: 'gemini-2.0-flash' });
    assert.equal(out, 'gemini-reply');
    assert.match(m.urls[0], /generativelanguage\.googleapis\.com/);
  } finally { m.restore(); }
});
