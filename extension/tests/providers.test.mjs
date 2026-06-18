// Multi-provider routing + HTTP adapters. Pins which model id maps to
// which provider, that the OpenAI/Google adapters read the right response
// shape, that transient statuses retry, and that key verification reports
// ok/fail. fetch is mocked — no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Secrets must exist before kb/db (imported transitively) validates env.
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { resolveProvider, providerApiKey, completeViaApi, verifyProvider, cliInvocation, listProviderModels } =
  await import('../agents/providers.mjs');

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('resolveProvider: maps model families', () => {
  assert.equal(resolveProvider('claude-sonnet-4-6'), 'anthropic');
  assert.equal(resolveProvider('gpt-4o'), 'openai');
  assert.equal(resolveProvider('o3-mini'), 'openai');
  assert.equal(resolveProvider('codex-mini-latest'), 'openai');
  assert.equal(resolveProvider('gemini-1.5-flash'), 'google');
  assert.equal(resolveProvider('models/gemini-2.0-flash'), 'google');
  assert.equal(resolveProvider(''), 'anthropic');       // blank → default
  assert.equal(resolveProvider('mystery-model'), 'anthropic');
});

test('providerApiKey: falls back to operator env when no user key', () => {
  process.env.OPENAI_API_KEY = 'sk-env-test';
  try {
    assert.equal(providerApiKey(null, 'openai'), 'sk-env-test');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
  assert.equal(providerApiKey(null, 'nonexistent'), null);
});

test('completeViaApi openai: returns assistant message content', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.match(url, /api\.openai\.com/);
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'gpt-4o');
    assert.equal(body.messages[0].content, 'hello');
    return jsonRes(200, { choices: [{ message: { content: 'hi there' } }] });
  });
  try {
    const out = await completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'hello' });
    assert.equal(out, 'hi there');
  } finally { restore(); }
});

test('completeViaApi google: extracts text from candidate parts', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com/);
    assert.match(url, /gemini-1\.5-flash:generateContent/);
    return jsonRes(200, { candidates: [{ content: { parts: [{ text: 'g1' }, { text: 'g2' }] } }] });
  });
  try {
    const out = await completeViaApi('google', { apiKey: 'k', model: 'gemini-1.5-flash', prompt: 'x' });
    assert.equal(out, 'g1g2');
  } finally { restore(); }
});

test('completeViaApi: retries a transient 503 then succeeds', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return calls === 1 ? jsonRes(503, { error: 'overloaded' })
                       : jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
  });
  try {
    const out = await completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  } finally { restore(); }
});

test('completeViaApi: throws on a non-transient 401 (no retry)', async () => {
  let calls = 0;
  const restore = mockFetch(async () => { calls += 1; return jsonRes(401, { error: 'bad key' }); });
  try {
    await assert.rejects(
      () => completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' }),
      /HTTP 401/,
    );
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('listProviderModels openai: parses { data: [{id}] }', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.match(url, /api\.openai\.com\/v1\/models/);
    assert.equal(opts.method, 'GET');
    return jsonRes(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
  });
  try {
    assert.deepEqual(await listProviderModels('openai', { apiKey: 'k' }), ['gpt-4o', 'gpt-4o-mini']);
  } finally { restore(); }
});

test('listProviderModels google: strips models/ prefix from names', async () => {
  const restore = mockFetch(async (url) => {
    assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models/);
    return jsonRes(200, { models: [{ name: 'models/gemini-2.0-flash' }, { name: 'models/gemini-1.5-pro' }] });
  });
  try {
    assert.deepEqual(await listProviderModels('google', { apiKey: 'k' }), ['gemini-2.0-flash', 'gemini-1.5-pro']);
  } finally { restore(); }
});

test('listProviderModels: throws on a 401', async () => {
  const restore = mockFetch(async () => jsonRes(401, { error: 'bad key' }));
  try {
    await assert.rejects(() => listProviderModels('openai', { apiKey: 'k' }), /HTTP 401/);
  } finally { restore(); }
});

test('verifyProvider: key mode lists models (GET) and reports ok', async () => {
  const restore = mockFetch(async (url, opts) => {
    assert.equal(opts.method, 'GET'); // no token-spending generate call
    return jsonRes(200, { data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] });
  });
  try {
    const r = await verifyProvider({ provider: 'openai', mode: 'key', apiKey: 'k' });
    assert.equal(r.ok, true);
    assert.match(r.detail, /2 models/);
  } finally { restore(); }
});

test('verifyProvider: key mode reports failure on a 401, never throws', async () => {
  const restore = mockFetch(async () => jsonRes(401, { error: 'nope' }));
  try {
    const r = await verifyProvider({ provider: 'anthropic', mode: 'key', apiKey: 'k' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /401/);
  } finally { restore(); }
});

test('verifyProvider: unknown provider fails gracefully', async () => {
  const r = await verifyProvider({ provider: 'skynet', mode: 'key', apiKey: 'k' });
  assert.equal(r.ok, false);
});

test('cliInvocation: standard non-interactive form per provider', () => {
  assert.deepEqual(cliInvocation('anthropic', 'hi'), { bin: 'claude', args: ['-p', 'hi'] });
  assert.deepEqual(cliInvocation('openai', 'hi'),    { bin: 'codex',  args: ['exec', 'hi'] });
  assert.deepEqual(cliInvocation('google', 'hi'),    { bin: 'gemini', args: ['-p', 'hi'] });
  assert.equal(cliInvocation('skynet', 'hi'), null);
});

test('cliInvocation: binary overridable via LLMIDE_<PROVIDER>_CLI', () => {
  process.env.LLMIDE_OPENAI_CLI = 'my-codex';
  try {
    assert.deepEqual(cliInvocation('openai', 'x'), { bin: 'my-codex', args: ['exec', 'x'] });
  } finally {
    delete process.env.LLMIDE_OPENAI_CLI;
  }
});

test('completeViaApi: a quota 429 is NOT retried (would only burn quota)', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return jsonRes(429, { error: { code: 'insufficient_quota', message: 'exceeded your current quota' } });
  });
  try {
    await assert.rejects(
      () => completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' }),
      /HTTP 429/,
    );
    assert.equal(calls, 1); // no retry
  } finally { restore(); }
});

test('completeViaApi: a rate-limit 429 (no quota marker) IS retried', async () => {
  let calls = 0;
  const restore = mockFetch(async () => {
    calls += 1;
    return calls === 1 ? jsonRes(429, { error: { message: 'rate limit, slow down' } })
                       : jsonRes(200, { choices: [{ message: { content: 'ok' } }] });
  });
  try {
    const out = await completeViaApi('openai', { apiKey: 'k', model: 'gpt-4o', prompt: 'x' });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
  } finally { restore(); }
});
