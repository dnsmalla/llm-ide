// Claude-compatible (Anthropic Messages) endpoints: catalog entry kind 'anthropic-compatible', connect/disconnect through
// the existing catalog routes, GET /kb/providers/custom (key presence only), dispatch to the Agent engine's auth ladder,
// the operator gate and SSRF guard, per-user isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, fakeFetch, jsonResponse } from './provider-test-env.mjs';

const { handleKB } = await import('../routes/router.mjs');
const conns = await import('../server/provider-connections.mjs');
const models = await import('../providers/provider-models.mjs');
const { getCustomProvider, syncCustomProviders } = await import('../server/custom-providers.mjs');
const { resolveCustomProviderDispatch } = await import('../providers/providers.mjs');
const { resolveAgentEngineAuth } = await import('../llm_agent/sdk/engine.mjs');
const { engineOf } = await import('../kb/chat-route.mjs');

const KEY = 'sk-claude-compat-0123456789';

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = { method, url, user: { id: userId }, headers: {}, on(e, cb) { if (e === 'data') chunks.forEach((c) => cb(c)); else if (e === 'end') cb(); return req; } };
  return req;
}
function makeRes() {
  return { statusCode: 200, headers: {}, _body: '', headersSent: false, writableEnded: false,
    writeHead(c, h) { this.statusCode = c; this.headersSent = true; Object.assign(this.headers, h || {}); },
    setHeader() {}, write(c) { this._body += c; return true; }, end(c) { if (c) this._body += c; this.writableEnded = true; },
    on() { return this; }, json() { return JSON.parse(this._body); } };
}
async function call(userId, method, url, body) {
  const res = makeRes();
  assert.equal(await handleKB(makeReq({ method, url, body, userId }), res), true);
  return res;
}

test('the built-in catalog carries the anthropic-compatible entry; the Mac-facing list and its shapes do not change', async () => {
  const { users: [a] } = freshDb();
  const { catalogEntry } = await import('../server/provider-catalog.mjs');
  const e = catalogEntry('anthropic-compatible');
  assert.equal(e.kind, 'anthropic-compatible');
  assert.equal(e.customBaseURL, true);
  assert.equal(e.keyRequired, true);
  const b = (await call(a, 'GET', '/kb/providers/catalog')).json();
  assert.ok(!b.providers.some((p) => p.id === 'anthropic-compatible'));
  assert.ok(b.providers.every((p) => !('kind' in p)));
});

test('connect + list: key never returned, hasKey true; disconnect removes it and the vault key', async () => {
  const { db, users: [a, other] } = freshDb();
  const noKey = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'anthropic-compatible', baseURL: 'https://gw.example.com/anthropic', slug: 'glm' });
  assert.equal(noKey.statusCode, 400, 'a key is required');
  const c = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'anthropic-compatible', baseURL: 'https://gw.example.com/anthropic/', slug: 'glm', name: 'GLM gateway', apiKey: KEY });
  assert.equal(c.statusCode, 200);
  assert.ok(!c._body.includes(KEY));
  assert.equal(c.json().connection.provider, 'custom:ac-glm');
  assert.ok(!('kind' in c.json().connection), 'the connection shape is unchanged');

  const list = await call(a, 'GET', '/kb/providers/custom');
  assert.equal(list.statusCode, 200);
  assert.ok(!list._body.includes(KEY));
  assert.deepEqual(list.json().providers.map((p) => [p.id, p.provider, p.name, p.hasKey, p.source, p.kind]), [['ac-glm', 'custom:ac-glm', 'GLM gateway', true, 'connection', 'anthropic-compatible']]);
  assert.equal((await call(other, 'GET', '/kb/providers/custom')).json().providers.length, 0, 'another user sees nothing');

  const d = await call(a, 'POST', '/kb/providers/catalog/disconnect', { id: 'ac-glm' });
  assert.equal(d.json().removed, true);
  assert.deepEqual((await call(a, 'GET', '/kb/providers/custom')).json().providers, []);
  void db;
});

test('Mac-synced custom providers with an Anthropic door are listed read-only, key presence only', async () => {
  const { db, users: [a] } = freshDb();
  syncCustomProviders([
    { id: 'zai', name: 'Z.AI', baseURL: 'https://api.z.ai/v1', apiKey: 'custom.zai.apiKey', anthropicBaseURL: 'https://api.z.ai/api/anthropic' },
    { id: 'plain', name: 'Plain', baseURL: 'https://x.example.com/v1', apiKey: 'custom.plain.apiKey' },
  ], a, db);
  const l = (await call(a, 'GET', '/kb/providers/custom')).json().providers;
  assert.deepEqual(l.map((p) => [p.id, p.source, p.hasKey, p.baseURL]), [['zai', 'synced', false, 'https://api.z.ai/api/anthropic']]);
});

test('an anthropic-compatible connection resolves to the Agent engine door, not the OpenAI adapter', async () => {
  const { db, users: [a, b] } = freshDb();
  conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'https://gw.example.com/anthropic', slug: 'glm', apiKey: KEY }, db);
  const cp = getCustomProvider('custom:ac-glm', a, db);
  assert.equal(cp.anthropicBaseURL, 'https://gw.example.com/anthropic');
  assert.equal(cp.isOpenAICompatible, false);
  const d = resolveCustomProviderDispatch('custom:ac-glm', a, db);
  assert.equal(d.apiKey, KEY);
  assert.equal(d.anthropicBaseUrl, 'https://gw.example.com/anthropic');
  const auth = resolveAgentEngineAuth('custom:ac-glm', a);
  assert.equal(auth.baseUrl, 'https://gw.example.com/anthropic');
  assert.equal(auth.key, KEY);
  assert.equal(resolveCustomProviderDispatch('custom:ac-glm', b, db).error, 'not_found');
  assert.equal(engineOf('custom:ac-glm'), 'claude', 'a Claude-compatible endpoint runs on the Agent engine');
});

test('private targets need the opt-in and the operator gate; blocked again at dispatch when the gate closes', async () => {
  const { db, users: [a] } = freshDb();
  assert.throws(() => conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'http://127.0.0.1:11434', slug: 'ollama', apiKey: KEY }, db), /https|private|local/i);
  assert.throws(() => conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'http://169.254.169.254', slug: 'meta', apiKey: KEY, allowPrivate: true }, db));
  assert.throws(() => conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'https://u:p@gw.example.com', slug: 'cred', apiKey: KEY }, db));
  assert.throws(() => conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'https://gw.example.com', slug: 'Bad Slug', apiKey: KEY }, db), /slug/);
  conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'http://127.0.0.1:11434', slug: 'ollama', apiKey: KEY, allowPrivate: true }, db);
  assert.equal(resolveCustomProviderDispatch('custom:ac-ollama', a, db).error, undefined);
  const prev = process.env.LLMIDE_ALLOW_PRIVATE_PROVIDERS;
  process.env.LLMIDE_ALLOW_PRIVATE_PROVIDERS = '0';
  try {
    const r = resolveCustomProviderDispatch('custom:ac-ollama', a, db);
    assert.equal(r.error, 'blocked');
    assert.throws(() => resolveAgentEngineAuth('custom:ac-ollama', a), /blocked/);
  } finally {
    if (prev === undefined) delete process.env.LLMIDE_ALLOW_PRIVATE_PROVIDERS; else process.env.LLMIDE_ALLOW_PRIVATE_PROVIDERS = prev;
  }
});

test('model list uses the Anthropic route and headers through the injected (pinned) fetch', async () => {
  const { db, users: [a] } = freshDb();
  models._clearModelCacheForTests();
  const conn = conns.connectProvider(a, { catalogId: 'anthropic-compatible', baseURL: 'https://gw.example.com/anthropic', slug: 'glm', apiKey: KEY }, db);
  const f = fakeFetch(() => jsonResponse({ data: [{ id: 'glm-4.6' }, { id: 'glm-4.5-air' }] }));
  const out = await models.listConnectionModels(a, conn, { fetchImpl: f, db });
  assert.deepEqual(out.models.map((m) => m.id), ['glm-4.5-air', 'glm-4.6']);
  assert.equal(f.calls[0].url, 'https://gw.example.com/anthropic/v1/models');
  assert.equal(f.calls[0].init.headers['x-api-key'], KEY);
  assert.equal(f.calls[0].init.redirect, 'error');
});
