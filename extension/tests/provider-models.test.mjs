// Model listing and connection tests against a fake fetch (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeFetch, jsonResponse } from './provider-test-env.mjs';

const conns = await import('../server/provider-connections.mjs');
const models = await import('../providers/provider-models.mjs');

const KEY = 'sk-live-abcdefghijklmnopqrstuv';

test('lists live models with capability flags and drops non-chat models', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'groq', apiKey: KEY }, db);
  const f = fakeFetch(() => jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'brand-new-model' }] }));
  const out = await models.listConnectionModels(a, conn, { fetchImpl: f, db });
  assert.equal(out.source, 'live');
  assert.deepEqual(out.models.map((m) => m.id), ['brand-new-model', 'llama-3.3-70b-versatile']);
  assert.equal(out.models.find((m) => m.id === 'llama-3.3-70b-versatile').toolsSupported, true);
  assert.equal(out.models.find((m) => m.id === 'brand-new-model').toolsSupported, false);
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.init.redirect, 'error', 'the key must never follow a redirect');
});

test('OpenRouter reports tool support per model from supported_parameters', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'openrouter', apiKey: KEY }, db);
  const f = fakeFetch(() => jsonResponse({ data: [
    { id: 'a/with-tools', context_length: 32000, supported_parameters: ['tools', 'temperature'] },
    { id: 'b/no-tools', context_length: 8000, supported_parameters: ['temperature'] },
  ] }));
  const out = await models.listConnectionModels(a, conn, { fetchImpl: f, db });
  const w = out.models.find((m) => m.id === 'a/with-tools');
  assert.deepEqual([w.toolsSupported, w.toolsSource, w.contextWindow], [true, 'provider', 32000]);
  assert.equal(out.models.find((m) => m.id === 'b/no-tools').toolsSupported, false);
});

test('Together answers a bare array and non-chat types are dropped', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'together', apiKey: KEY }, db);
  const f = fakeFetch(() => jsonResponse([{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', context_length: 131072 }, { id: 'some/image-model', type: 'image' }]));
  const out = await models.listConnectionModels(a, conn, { fetchImpl: f, db });
  assert.deepEqual(out.models.map((m) => m.id), ['meta-llama/Llama-3.3-70B-Instruct-Turbo']);
});

test('provider down or key refused: static fallback, detail redacted, no throw', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'openai', apiKey: KEY }, db);
  const f401 = fakeFetch(() => new Response(`{"error":"bad key ${KEY}"}`, { status: 401 }));
  const out = await models.listConnectionModels(a, conn, { fetchImpl: f401, db });
  assert.equal(out.source, 'static');
  assert.ok(out.models.length >= 1 && out.models.every((m) => m.toolsSupported));
  assert.ok(!JSON.stringify(out).includes(KEY), 'the key must not appear in the detail');
  assert.match(out.detail, /refused/);
  const down = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  const out2 = await models.listConnectionModels(a, conn, { fetchImpl: down, db, refresh: true });
  assert.equal(out2.source, 'static');
  assert.match(out2.detail, /ECONNREFUSED/);
  const out3 = await models.testConnection(a, conn, { fetchImpl: down, db });
  assert.equal(out3.ok, false);
});

test('a cached list survives a later outage and refresh bypasses the cache', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'mistral', apiKey: KEY }, db);
  const ok = fakeFetch(() => jsonResponse({ data: [{ id: 'mistral-large-latest' }] }));
  await models.listConnectionModels(a, conn, { fetchImpl: ok, db });
  const out = await models.listConnectionModels(a, conn, { fetchImpl: ok, db });
  assert.equal(out.source, 'cache');
  assert.equal(ok.calls.length, 1);
  const down = fakeFetch(() => new Response('x', { status: 503 }));
  const stale = await models.listConnectionModels(a, conn, { fetchImpl: down, db, refresh: true });
  assert.equal(stale.source, 'cache');
  assert.match(stale.detail, /503/);
});

test('user overrides flip the tools flag; another user\'s cache and overrides are separate', async () => {
  const { db, users: [a, b] } = freshDb();
  models._clearModelCacheForTests();
  const ca = conns.connectProvider(a, { catalogId: 'groq', apiKey: KEY }, db);
  const cb = conns.connectProvider(b, { catalogId: 'groq', apiKey: 'sk-b-0123456789abcdefgh' }, db);
  conns.updateSettings(a, { toolOverrides: { 'cat-groq/brand-new-model': true } }, db);
  const f = fakeFetch(() => jsonResponse({ data: [{ id: 'brand-new-model' }] }));
  const ra = await models.listConnectionModels(a, ca, { fetchImpl: f, db });
  const rb = await models.listConnectionModels(b, cb, { fetchImpl: f, db });
  assert.equal(ra.models[0].toolsSupported, true);
  assert.equal(rb.models[0].toolsSupported, false);
  assert.equal(f.calls.length, 2, 'B did not read A\'s cache');
  assert.equal(f.calls[1].init.headers.Authorization, 'Bearer sk-b-0123456789abcdefgh');
});

test('Ollama: no key header, loopback allowed only for the local entry', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'ollama' }, db);
  const f = fakeFetch(() => jsonResponse({ data: [{ id: 'qwen2.5:7b' }, { id: 'nomic-embed-text' }] }));
  const out = await models.listConnectionModels(a, conn, { fetchImpl: f, db });
  assert.equal(f.calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(out.models.map((m) => [m.id, m.toolsSupported, m.toolsSource]), [['qwen2.5:7b', true, 'inferred']]);
});

test('test connection: ok with a count, and a missing key is reported without a request', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'xai', apiKey: KEY }, db);
  const f = fakeFetch(() => jsonResponse({ data: [{ id: 'grok-4' }, { id: 'grok-3-mini' }] }));
  const t = await models.testConnection(a, conn, { fetchImpl: f, db });
  assert.deepEqual([t.ok, t.modelCount], [true, 2]);
  db.prepare('DELETE FROM user_secrets WHERE user_id=?').run(a);
  const f2 = fakeFetch(() => jsonResponse({}));
  const t2 = await models.testConnection(a, conn, { fetchImpl: f2, db });
  assert.equal(t2.ok, false);
  assert.equal(f2.calls.length, 0);
});
