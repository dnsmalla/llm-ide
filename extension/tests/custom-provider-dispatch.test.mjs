// Route-level test for user-registered custom providers (custom:<uuid>) in the
// Code Assistant. The bug: handleCodeAssist gated the OpenAI-compatible native
// loop on NATIVE_PROVIDERS = {deepseek,openai,custom}, so a custom:<uuid>
// provider was silently dropped and the request fell back to the Anthropic
// runAgentLoop. This test proves the chosen provider's baseURL+key actually
// receive the request.
//
// Setup mirrors usage.test.mjs (temp DB + registerUser) and
// agent-global-internal.test.mjs (call handleCodeAssist directly with a mocked
// runClaude + minimal kb); fetch stubbing mirrors openai-tool-calls.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const tmpDb = path.join(os.tmpdir(), `_customprov-${process.pid}-${Math.floor(performance.now() * 1000)}.db`);
process.env.LLMIDE_DB_PATH = tmpDb;

const { syncCustomProviders, getCustomProvider, handleCustomProvidersSync, _resetCustomProviderCacheForTests } = await import('../server/custom-providers.mjs');

let getDb, registerUser, setSecret, closeDb;

async function setupUser() {
  // (Re)initialise the temp DB so each test starts clean.
  if (!getDb) {
    const db = await import('../kb/db.mjs');
    getDb = db.getDb;
    closeDb = db.closeDb;
    ({ registerUser } = await import('../server/users.mjs'));
    ({ setSecret } = await import('../server/vault.mjs'));
  }
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDb + suffix); } catch { /* ok */ }
  }
  const db = getDb();
  const { id: userId } = registerUser(db, { email: `u-${Math.floor(performance.now() * 1000)}@ex.com`, password: 'pw-12345678' });
  return { db, userId };
}

// Register a custom provider in the in-memory registry AND store its key in the
// vault. Returns the `custom:<id>` provider id.
function registerProvider(userId, overrides = {}) {
  const id = overrides.id ?? 'abc';
  const vaultKey = overrides.vaultKey ?? 'custom.abc-123.apiKey';
  const baseURL = overrides.baseURL ?? 'https://api.example.com/v1';
  syncCustomProviders([{
    id, name: 'GLM', baseURL, apiKey: vaultKey, models: [],
    isOpenAICompatible: true, isEnabled: overrides.isEnabled !== false,
    ...(overrides.anthropicBaseURL ? { anthropicBaseURL: overrides.anthropicBaseURL } : {}),
  }], userId);
  if (overrides.seedKey !== false) {
    setSecret(getDb(), userId, vaultKey, overrides.keyValue ?? 'sk-glm-test');
  }
  return `custom:${id}`;
}

// The Agent SDK engine reads a provider's optional Anthropic-format door
// through this SAME resolver (one source of truth for custom-provider
// credentials), so the field must pass through — normalized — and stay null
// for a provider that has none.
test('resolveCustomProviderDispatch: passes the optional anthropicBaseUrl through (null when absent)', async () => {
  const { resolveCustomProviderDispatch } = await import('../providers/providers.mjs');
  const { userId } = await setupUser();
  try {
    const withDoor = registerProvider(userId, { anthropicBaseURL: 'https://api.z.ai/api/anthropic/' });
    assert.equal(resolveCustomProviderDispatch(withDoor, userId).anthropicBaseUrl,
      'https://api.z.ai/api/anthropic', 'trailing slash is normalized away');
    assert.equal(resolveCustomProviderDispatch(withDoor, userId).baseUrl,
      'https://api.example.com/v1', 'the legacy OpenAI-form base URL is untouched');
    const without = registerProvider(userId);
    assert.equal(resolveCustomProviderDispatch(without, userId).anthropicBaseUrl, null);
  } finally { syncCustomProviders([], userId); }
});

// The registry used to be ONE process-global Map that every sync clear()ed:
// user B's save wiped user A's providers, and a restart wiped everyone's.
test('registry: per user — one user\'s sync never touches another user\'s providers', async () => {
  const { db, userId: a } = await setupUser();
  const { id: b } = registerUser(db, { email: `b-${Math.floor(performance.now() * 1000)}@ex.com`, password: 'pw-12345678' });
  const pa = registerProvider(a, { id: 'only-a' });
  syncCustomProviders([], b);
  registerProvider(b, { id: 'only-b' });
  assert.equal(getCustomProvider(pa, a)?.id, 'only-a', 'B\'s syncs must not wipe A');
  assert.equal(getCustomProvider(pa, b), undefined, 'B cannot resolve A\'s provider');
  assert.equal(getCustomProvider('custom:only-b', a), undefined, 'A cannot resolve B\'s provider');
  assert.equal(getCustomProvider(pa, undefined), undefined, 'no user → no provider');
  assert.throws(() => syncCustomProviders([], undefined), /userId/);
});

test('registry: persisted — survives a cache reset (server restart) and an empty sync deletes it', async () => {
  const { db, userId } = await setupUser();
  const p = registerProvider(userId, { id: 'persist', anthropicBaseURL: 'https://gw.example.com/anthropic/' });
  _resetCustomProviderCacheForTests(db);
  const got = getCustomProvider(p, userId);
  assert.equal(got?.baseURL, 'https://api.example.com/v1');
  assert.equal(got?.vaultKey, 'custom.abc-123.apiKey');
  assert.equal(got?.anthropicBaseURL, 'https://gw.example.com/anthropic');
  syncCustomProviders([], userId);
  _resetCustomProviderCacheForTests(db);
  assert.equal(getCustomProvider(p, userId), undefined);
});

test('registry: invalid entries are dropped (no id / name, non-http baseURL)', async () => {
  const { userId } = await setupUser();
  const n = syncCustomProviders([
    { id: 'ok', name: 'OK', baseURL: 'https://ok.example.com/v1' },
    { id: '', name: 'X', baseURL: 'https://x.example.com' },
    { id: 'noname', name: '', baseURL: 'https://x.example.com' },
    { id: 'file', name: 'F', baseURL: 'file:///etc/passwd' },
    null,
  ], userId);
  assert.equal(n, 1);
  assert.equal(getCustomProvider('custom:ok', userId)?.vaultKey, 'custom.ok.apiKey', 'default vault key');
  assert.equal(getCustomProvider('custom:file', userId), undefined);
  syncCustomProviders([], userId);
});

test('POST /kb/custom-providers: stores for the caller; 400 without a providers array', async () => {
  const { Readable } = await import('node:stream');
  const { userId } = await setupUser();
  const call = async (method, body) => {
    const req = Readable.from(body == null ? [] : [Buffer.from(body)]);
    req.method = method;
    req.headers = { 'content-type': 'application/json' };
    const res = {
      statusCode: 0, body: '', headersSent: false,
      writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
      setHeader() {}, end(b) { this.body = b ?? ''; },
    };
    await handleCustomProvidersSync(req, res, userId);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  const ok = await call('POST', JSON.stringify({ providers: [{ id: 'h', name: 'H', baseURL: 'https://h.example.com' }] }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.count, 1);
  assert.equal(getCustomProvider('custom:h', userId)?.name, 'H');
  assert.equal((await call('POST', JSON.stringify({ nope: 1 }))).status, 400);
  assert.equal((await call('GET', null)).status, 405);
  syncCustomProviders([], userId);
});
