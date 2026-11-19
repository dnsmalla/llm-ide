// Tests for providers/runtime.mjs — specifically the "user-scoped key
// must not silently fall back to the operator CLI on HTTP failure"
// guarantee.  Without it, a 401 from a user's own Anthropic key
// would cause runClaude to spawn `claude -p ...` under the operator's
// CLI auth, charging the wrong account and bypassing the user's
// quota/rate-limits.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// Load the pinned fetch before any test swaps globalThis.fetch: its NODE_ENV=test seam honours a swap
// only when the module saw the original fetch first.
import '../server/pinned-fetch.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agents-runtime-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

// Make sure nothing falls back to a real operator CLI accidentally.
delete process.env.ANTHROPIC_API_KEY;

const db = await import('../kb/db.mjs');
const vault = await import('../server/vault.mjs');
const users = await import('../server/users.mjs');

function resetDb() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
}

// Spy on child_process.execFile so a leak — runClaude falling back to
// the operator CLI — fails the test loudly.
import childProcess from 'node:child_process';

test('runClaude does NOT fall back to operator CLI when user-scoped key returns 401', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), {
    email: `runtime-${Date.now()}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'r',
  });
  vault.setSecret(db.getDb(), u.id, 'claude.apiKey', 'sk-user-scoped-xyz');

  // Force a 401 from the Anthropic API.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    async text() { return '{"error":"unauthorized"}'; },
  });
  const execSpy = mock.method(childProcess, 'execFile', () => {
    throw new Error('execFile MUST NOT be called when user-scoped key fails');
  });

  // Re-import runtime to pick up the spied execFile (it captures the
  // import binding at evaluation time, so it should already see
  // childProcess.execFile via the module reference).
  const { runClaude } = await import('../providers/runtime.mjs');

  try {
    await assert.rejects(
      () => runClaude('hello', { userId: u.id }),
      /401|user-scoped/i,
    );
    assert.equal(execSpy.mock.callCount(), 0,
      'execFile must not be invoked when a user-scoped key was used');
  } finally {
    globalThis.fetch = originalFetch;
    execSpy.mock.restore();
  }
});

test('a user-scoped key: a redirect from api.anthropic.com is refused on both paths and the CLI never runs', async () => {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `runtime-redirect-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' });
  vault.setSecret(db.getDb(), u.id, 'claude.apiKey', 'sk-user-scoped-xyz');
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), redirect: init.redirect }); return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }); };
  const execSpy = mock.method(childProcess, 'execFile', () => { throw new Error('execFile MUST NOT be called when user-scoped key fails'); });
  const { runClaude, runClaudeStream } = await import('../providers/runtime.mjs');
  try {
    await assert.rejects(() => runClaude('hello', { userId: u.id }), /redirect 302 not followed/);
    await assert.rejects(() => runClaudeStream('hello', { userId: u.id, onChunk: () => {} }), /redirect 302 not followed/);
    assert.ok(seen.length >= 2);
    for (const s of seen) assert.deepEqual(s, { url: 'https://api.anthropic.com/v1/messages', redirect: 'manual' });
    assert.equal(execSpy.mock.callCount(), 0);
  } finally { globalThis.fetch = originalFetch; execSpy.mock.restore(); }
});

// ── What the model answered, not just content[0] (LLM usage review 2026-11-19) ──
async function withUserKey(replies, run) {
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `runtime-${Date.now()}-${Math.random()}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' });
  vault.setSecret(db.getDb(), u.id, 'claude.apiKey', 'sk-user-scoped-xyz');
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const data = replies[Math.min(bodies.length - 1, replies.length - 1)];
    return { ok: true, status: 200, headers: new Headers(), async json() { return data; } };
  };
  const execSpy = mock.method(childProcess, 'execFile', () => { throw new Error('the CLI must not run'); });
  const { runClaude } = await import('../providers/runtime.mjs');
  try { return await run((prompt, opts = {}) => runClaude(prompt, { userId: u.id, ...opts }), bodies); }
  finally { globalThis.fetch = originalFetch; execSpy.mock.restore(); }
}
const usage = { input_tokens: 10, output_tokens: 5 };

test('runClaude returns the text blocks even when a thinking block comes first', async () => {
  await withUserKey([{ stop_reason: 'end_turn', usage, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'the ' }, { type: 'text', text: 'answer' }] }], async (ask) => {
    assert.equal(await ask('q'), 'the answer');
  });
});

test('runClaude treats a refusal as a refusal: no text returned, no CLI fallback', async () => {
  await withUserKey([{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, usage, content: [{ type: 'text', text: 'partial' }] }], async (ask) => {
    await assert.rejects(() => ask('q'), (e) => e.code === 'MODEL_REFUSED' && /declined this request \(cyber\)/.test(e.message));
  });
});

test('runClaude retries a reply cut off at max_tokens once, with twice the room', async () => {
  await withUserKey([
    { stop_reason: 'max_tokens', usage, content: [{ type: 'text', text: '{"half":' }] },
    { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: '{"half":true}' }] },
  ], async (ask, bodies) => {
    assert.equal(await ask('q', { maxTokens: 1000 }), '{"half":true}');
    assert.deepEqual(bodies.map((b) => b.max_tokens), [1000, 2000]);
  });
  // Still cut off after the retry: the text comes back (callers that need JSON reject it themselves).
  await withUserKey([{ stop_reason: 'max_tokens', usage, content: [{ type: 'text', text: 'long…' }] }], async (ask, bodies) => {
    assert.equal(await ask('q', { maxTokens: 1000 }), 'long…');
    assert.equal(bodies.length, 2);
  });
});

test('a retired model id is sent as its successor, and the catalog offers the current models', async () => {
  await withUserKey([{ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] }], async (ask, bodies) => {
    await ask('q', { model: 'claude-sonnet-4-6' });
    await ask('q', { model: 'claude-opus-4-8[1m]' });
    assert.deepEqual(bodies.map((b) => b.model), ['claude-sonnet-5-5', 'claude-opus-5-5']);
  });
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'schema', 'models', 'anthropic-models.json'), 'utf8'));
  assert.ok(catalog.models.some((m) => m.id === 'claude-fable-5-2'));
  for (const id of Object.values(catalog.retired)) assert.ok(!Object.hasOwn(catalog.retired, id), `${id} is a successor, never retired itself`);
  const { estimateTurnCostUsd } = await import('../kb/usage.mjs');
  const million = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'].map((m) => estimateTurnCostUsd(m, million)), [24, 12, 0.6, 48]);
});

test('jsonSchema is sent as output_config.format, and a rejected schema is dropped, not fatal', async () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  await withUserKey([{ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: '{"ok":true}' }] }], async (ask, bodies) => {
    assert.equal(await ask('q', { jsonSchema: schema }), '{"ok":true}');
    assert.deepEqual(bodies[0].output_config, { format: { type: 'json_schema', schema } });
    await ask('q');
    assert.equal(bodies[1].output_config, undefined, 'only when a caller asks');
  });
  // A 400 naming the schema: one more call without it.
  resetDb();
  const u = users.registerUser(db.getDb(), { email: `schema-${Date.now()}@example.com`, password: 'CorrectHorseBattery', displayName: 'r' });
  vault.setSecret(db.getDb(), u.id, 'claude.apiKey', 'sk-user-scoped-xyz');
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (bodies.length === 1) return { ok: false, status: 400, headers: new Headers(), async text() { return '{"error":{"message":"output_config.format.schema: unsupported keyword"}}'; } };
    return { ok: true, status: 200, headers: new Headers(), async json() { return { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: '{"ok":true}' }] }; } };
  };
  const { runClaude } = await import('../providers/runtime.mjs');
  try {
    assert.equal(await runClaude('q', { userId: u.id, jsonSchema: schema }), '{"ok":true}');
    assert.deepEqual(bodies.map((b) => !!b.output_config), [true, false]);
  } finally { globalThis.fetch = originalFetch; }
});
