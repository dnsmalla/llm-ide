// /kb/providers/catalog* and /kb/providers/settings through
// the real router, with globalThis.fetch standing in for every provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './provider-test-env.mjs';

const { handleKB } = await import('../routes/router.mjs');
const models = await import('../providers/provider-models.mjs');
const { _setPinnedFetchForTests } = await import('../server/pinned-fetch.mjs');
const { _clearCooldownsForTests } = await import('../providers/provider-fallback.mjs');

const KEY = 'sk-route-0123456789abcdefgh';

function makeReq({ method, url, body, userId }) {
  const chunks = body == null ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method, url, user: { id: userId }, headers: {},
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
    statusCode: 200, headers: {}, _body: '', headersSent: false, writableEnded: false,
    writeHead(code, h) { this.statusCode = code; this.headersSent = true; Object.assign(this.headers, h || {}); },
    setHeader(k, v) { this.headers[k] = v; },
    write(c) { this._body += c; return true; },
    end(c) { if (c) this._body += c; this.writableEnded = true; },
    on() { return this; },
    json() { return JSON.parse(this._body); },
    events() { return this._body.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))); },
  };
}
async function call(userId, method, url, body) {
  const req = makeReq({ method, url, body, userId });
  const res = makeRes();
  assert.equal(await handleKB(req, res), true);
  return res;
}
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  const stand = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  globalThis.fetch = stand;
  _setPinnedFetchForTests(stand);
  try { return await fn(calls); } finally { globalThis.fetch = original; _setPinnedFetchForTests(null); }
}
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

test('catalog lists every provider with no connection for a fresh user, switches off', async () => {
  const { users: [a] } = freshDb();
  const res = await call(a, 'GET', '/kb/providers/catalog');
  assert.equal(res.statusCode, 200);
  const b = res.json();
  assert.equal(b.providers.length, 11, 'the Claude-compatible entry is not in the Mac-facing list');
  assert.ok(b.providers.every((p) => p.connections.length === 0));
  assert.deepEqual(b.settings, { toolsEnabled: false, fallbackEnabled: false, fallbackOrder: [], toolOverrides: {}, egressAutoApprove: false });
});

test('connect never echoes the key, and the catalog then shows a key is present', async () => {
  const { users: [a, b] } = freshDb();
  const res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'groq', apiKey: KEY });
  assert.equal(res.statusCode, 200);
  assert.ok(!res._body.includes(KEY));
  assert.deepEqual([res.json().connection.provider, res.json().connection.hasKey], ['custom:cat-groq', true]);
  const cat = await call(a, 'GET', '/kb/providers/catalog');
  assert.ok(!cat._body.includes(KEY));
  assert.equal(cat.json().providers.find((p) => p.id === 'groq').connections.length, 1);
  // per-user: B sees nothing
  const catB = await call(b, 'GET', '/kb/providers/catalog');
  assert.equal(catB.json().providers.find((p) => p.id === 'groq').connections.length, 0);
  assert.equal((await call(b, 'POST', '/kb/providers/catalog/models', { id: 'cat-groq' })).statusCode, 404);
  assert.equal((await call(b, 'POST', '/kb/providers/catalog/test', { id: 'cat-groq' })).statusCode, 404);
});

test('connect validation answers 400/404 with the envelope and never leaks the key', async () => {
  const { users: [a] } = freshDb();
  let res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'nope', apiKey: KEY });
  assert.equal(res.statusCode, 404);
  res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'VALIDATION_FAILED');
  res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai', apiKey: KEY, baseURL: 'https://attacker.example.com/v1' });
  assert.equal(res.statusCode, 400);
  assert.ok(!res._body.includes(KEY));
  res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai-compatible', baseURL: 'http://169.254.169.254/latest', allowPrivate: true });
  assert.equal(res.statusCode, 400);
});

test('models and test use the stored key against the catalog host and report capability flags', async () => {
  const { users: [a] } = freshDb();
  models._clearModelCacheForTests();
  await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'groq', apiKey: KEY });
  await withFetch(() => json({ data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'new-one' }] }), async (calls) => {
    const res = await call(a, 'POST', '/kb/providers/catalog/models', { id: 'cat-groq', refresh: true });
    const b = res.json();
    assert.equal(b.source, 'live');
    assert.deepEqual(b.models.map((m) => [m.id, m.toolsSupported]), [['llama-3.3-70b-versatile', true], ['new-one', false]]);
    assert.ok(!res._body.includes(KEY));
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/models');
    const t = await call(a, 'POST', '/kb/providers/catalog/test', { id: 'cat-groq' });
    assert.deepEqual([t.json().ok, t.json().modelCount], [true, 2]);
  });
  // provider down and nothing cached: still 200 with the static list and a reason
  models._clearModelCacheForTests();
  await withFetch(() => json({ error: `key ${KEY} refused` }, 401), async () => {
    const res = await call(a, 'POST', '/kb/providers/catalog/models', { id: 'cat-groq', refresh: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().source, 'static');
    assert.ok(!res._body.includes(KEY));
    const t = await call(a, 'POST', '/kb/providers/catalog/test', { id: 'cat-groq' });
    assert.equal(t.json().ok, false);
    assert.ok(!t._body.includes(KEY));
  });
});

test('settings round trip; unknown fields ignored; disconnect clears the key', async () => {
  const { users: [a], db } = freshDb();
  await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'groq', apiKey: KEY });
  let res = await call(a, 'PUT', '/kb/providers/settings', { toolsEnabled: true, fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-groq' }, { provider: 'custom:cat-nobody' }], evil: 1 });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { toolsEnabled: true, fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-groq' }], toolOverrides: {}, egressAutoApprove: false });
  assert.deepEqual((await call(a, 'GET', '/kb/providers/settings')).json(), res.json());
  res = await call(a, 'POST', '/kb/providers/catalog/disconnect', { id: 'cat-groq' });
  assert.deepEqual(res.json(), { ok: true, removed: true });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_secrets WHERE user_id=?').get(a).n, 0);
});

test('a malformed body is a 400, not a 500', async () => {
  const { users: [a] } = freshDb();
  const req = makeReq({ method: 'POST', url: '/kb/providers/catalog/connect', userId: a });
  const chunks = [Buffer.from('{not json')];
  req.on = (ev, cb) => { if (ev === 'data') chunks.forEach((c) => cb(c)); else if (ev === 'end') cb(); return req; };
  const res = makeRes();
  await handleKB(req, res);
  assert.equal(res.statusCode, 400);
});

test('the existing verify and models routes are untouched by the new handler', async () => {
  const { users: [a] } = freshDb();
  const res = await call(a, 'POST', '/kb/providers/verify', { provider: 'skynet' });
  assert.equal(res.statusCode, 400);
});

test('a submitted key is redacted even if an error message were to carry it', async () => {
  const { users: [a] } = freshDb();
  // the slug check echoes user input in its message; a key-shaped slug must not survive in the answer
  const key = 'sk-echo-0123456789abcdefghij';
  const res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai-compatible', slug: key, apiKey: key, baseURL: 'https://x.example.com/v1' });
  assert.equal(res.statusCode, 400);
  assert.ok(!res._body.includes(key));
});

test('first GET of the catalog carries a DeepSeek-only user over once: a connection, tools still off but suggested, the migration block', async () => {
  const { db, users: [a] } = freshDb();
  const { setSecret } = await import('../server/vault.mjs');
  setSecret(db, a, 'deepseek.apiKey', 'sk-legacy-0123456789abcdefgh');
  const first = (await call(a, 'GET', '/kb/providers/catalog')).json();
  const ds = first.providers.find((p) => p.id === 'deepseek');
  assert.equal(ds.connections.length, 1);
  assert.equal(ds.connections[0].provider, 'custom:cat-deepseek');
  assert.equal(first.settings.toolsEnabled, false);
  assert.deepEqual(first.migration, { created: [{ provider: 'deepseek', name: 'DeepSeek' }], needsReview: [], toolsSuggested: true });
  assert.ok(!JSON.stringify(first).includes('sk-legacy'), 'no key in the response');
  const second = (await call(a, 'GET', '/kb/providers/catalog')).json();
  assert.equal(second.providers.find((p) => p.id === 'deepseek').connections.length, 1);
  assert.deepEqual(second.migration, first.migration);
});

test('connect copyKeyFrom copies a legacy key (old one kept, never echoed); an unknown or foreign source is refused; enabled:false sticks', async () => {
  const { db, users: [a, b] } = freshDb();
  const { setSecret, getSecret } = await import('../server/vault.mjs');
  setSecret(db, a, 'openai.apiKey', KEY);
  let res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai', copyKeyFrom: 'openai' });
  assert.equal(res.statusCode, 200);
  assert.ok(!res._body.includes(KEY));
  assert.equal(res.json().connection.hasKey, true);
  assert.equal(getSecret(db, a, 'custom.cat-openai.apiKey'), KEY);
  assert.equal(getSecret(db, a, 'openai.apiKey'), KEY, 'the legacy key is untouched');
  // another user has no such legacy key; an arbitrary vault key name is not a valid source
  res = await call(b, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai', copyKeyFrom: 'openai' });
  assert.equal(res.statusCode, 400);
  res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'groq', copyKeyFrom: 'openai.apiKey' });
  assert.equal(res.statusCode, 400);
  // switching a connection off keeps its key and shows enabled:false
  res = await call(a, 'POST', '/kb/providers/catalog/connect', { catalogId: 'openai', enabled: false });
  assert.deepEqual([res.json().connection.enabled, res.json().connection.hasKey], [false, true]);
});
