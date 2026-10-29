// Per-user provider connections: keys in the vault, per-user isolation, dispatch
// compatibility with the custom-provider path, settings defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './provider-test-env.mjs';

const conns = await import('../server/provider-connections.mjs');
const { getSecret } = await import('../server/vault.mjs');
const { getCustomProvider, syncCustomProviders } = await import('../server/custom-providers.mjs');
const { resolveCustomProviderDispatch } = await import('../providers/providers.mjs');

const KEY = 'sk-test-abcdefghijklmnop';

test('connect puts the key in the vault, not in the connection record', () => {
  const { db, users: [a] } = freshDb();
  const c = conns.connectProvider(a, { catalogId: 'openai', apiKey: KEY }, db);
  assert.equal(c.id, 'cat-openai');
  assert.equal(c.provider, 'custom:cat-openai');
  assert.equal(c.hasKey, true);
  assert.equal(getSecret(db, a, 'custom.cat-openai.apiKey'), KEY);
  assert.ok(!JSON.stringify(conns.listConnections(a, db)).includes(KEY));
  const raw = db.prepare("SELECT value FROM user_flags WHERE user_id=? AND flag='provider.catalog'").get(a).value;
  assert.ok(!raw.includes(KEY), 'the flag JSON must not hold the key');
  const secretRow = db.prepare('SELECT ciphertext FROM user_secrets WHERE user_id=? AND secret_key=?').get(a, 'custom.cat-openai.apiKey');
  assert.ok(!String(secretRow.ciphertext).includes(KEY), 'the vault row is encrypted');
});

test('a connection dispatches as custom:cat-<id> through the existing custom-provider resolver', () => {
  const { db, users: [a] } = freshDb();
  conns.connectProvider(a, { catalogId: 'groq', apiKey: KEY }, db);
  assert.ok(getCustomProvider('custom:cat-groq', a, db));
  const d = resolveCustomProviderDispatch('custom:cat-groq', a, db);
  assert.equal(d.apiKey, KEY);
  assert.equal(d.baseUrl, 'https://api.groq.com/openai/v1');
});

test('per-user isolation: another user sees no connection, no key, and cannot disconnect it', () => {
  const { db, users: [a, b] } = freshDb();
  conns.connectProvider(a, { catalogId: 'openai', apiKey: KEY }, db);
  assert.deepEqual(conns.listConnections(b, db), []);
  assert.equal(getCustomProvider('custom:cat-openai', b, db), undefined);
  assert.equal(resolveCustomProviderDispatch('custom:cat-openai', b, db).error, 'not_found');
  assert.equal(conns.disconnectProvider(b, 'cat-openai', db), false);
  assert.equal(conns.listConnections(a, db).length, 1);
  // same catalog entry for B uses B's own vault slot
  conns.connectProvider(b, { catalogId: 'openai', apiKey: 'sk-other-0123456789abcd' }, db);
  assert.equal(getSecret(db, a, 'custom.cat-openai.apiKey'), KEY);
  assert.equal(getSecret(db, b, 'custom.cat-openai.apiKey'), 'sk-other-0123456789abcd');
});

test('a key without its owner id cannot be decrypted (vault is per-user)', () => {
  const { db, users: [a, b] } = freshDb();
  conns.connectProvider(a, { catalogId: 'openai', apiKey: KEY }, db);
  const row = db.prepare('SELECT ciphertext FROM user_secrets WHERE user_id=? AND secret_key=?').get(a, 'custom.cat-openai.apiKey');
  db.prepare('INSERT INTO user_secrets (user_id, secret_key, ciphertext) VALUES (?, ?, ?)').run(b, 'custom.cat-openai.apiKey', row.ciphertext);
  assert.throws(() => getSecret(db, b, 'custom.cat-openai.apiKey'));
});

test('the Mac whole-list custom provider sync does not wipe catalog connections', () => {
  const { db, users: [a] } = freshDb();
  conns.connectProvider(a, { catalogId: 'openai', apiKey: KEY }, db);
  syncCustomProviders([], a, db);
  assert.ok(getCustomProvider('custom:cat-openai', a, db));
});

test('connect validation: unknown entry, missing key, fixed URL, bad URL, odd keys', () => {
  const { db, users: [a] } = freshDb();
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'nope', apiKey: KEY }, db)), 'NOT_FOUND');
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai' }, db)), 'VALIDATION_FAILED');
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai', apiKey: 'has space inside' }, db)), 'VALIDATION_FAILED');
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai', apiKey: 'k'.repeat(600) }, db)), 'VALIDATION_FAILED');
  // a hosted entry never takes another host (the key would go there)
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai', apiKey: KEY, baseURL: 'https://evil.example.com/v1' }, db)), 'VALIDATION_FAILED');
  // generic endpoint: https public ok; private needs the opt-in; metadata never
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai-compatible', baseURL: 'http://192.168.1.9:3001/v1' }, db)), 'VALIDATION_FAILED');
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai-compatible', baseURL: 'http://192.168.1.9:3001/v1', allowPrivate: true }, db)), null);
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai-compatible', slug: 'meta', baseURL: 'http://169.254.169.254/v1', allowPrivate: true }, db)), 'VALIDATION_FAILED');
  assert.equal(code(() => conns.connectProvider(a, { catalogId: 'openai-compatible', slug: 'Bad Slug!', baseURL: 'https://x.example.com/v1' }, db)), 'VALIDATION_FAILED');
});

test('keyless providers (Ollama) get a non-secret placeholder so dispatch works', () => {
  const { db, users: [a] } = freshDb();
  const c = conns.connectProvider(a, { catalogId: 'ollama' }, db);
  assert.equal(c.baseURL, 'http://localhost:11434/v1');
  assert.equal(c.allowPrivate, true);
  assert.equal(resolveCustomProviderDispatch('custom:cat-ollama', a, db).apiKey, 'not-required');
});

test('reconnecting without a key keeps the stored key; a new key replaces it', () => {
  const { db, users: [a] } = freshDb();
  conns.connectProvider(a, { catalogId: 'mistral', apiKey: KEY }, db);
  conns.connectProvider(a, { catalogId: 'mistral', name: 'Mistral (work)' }, db);
  assert.equal(getSecret(db, a, 'custom.cat-mistral.apiKey'), KEY);
  assert.equal(conns.getConnection('cat-mistral', a, db).name, 'Mistral (work)');
  conns.connectProvider(a, { catalogId: 'mistral', apiKey: 'sk-new-0123456789abcdef' }, db);
  assert.equal(getSecret(db, a, 'custom.cat-mistral.apiKey'), 'sk-new-0123456789abcdef');
});

test('disconnect removes the key and the fallback slot', () => {
  const { db, users: [a] } = freshDb();
  conns.connectProvider(a, { catalogId: 'groq', apiKey: KEY }, db);
  conns.updateSettings(a, { fallbackOrder: [{ provider: 'custom:cat-groq' }] }, db);
  assert.equal(conns.getSettings(a, db).fallbackOrder.length, 1);
  assert.equal(conns.disconnectProvider(a, 'custom:cat-groq', db), true);
  assert.equal(getSecret(db, a, 'custom.cat-groq.apiKey'), null);
  assert.deepEqual(conns.getSettings(a, db).fallbackOrder, []);
  assert.equal(conns.listConnections(a, db).length, 0);
});

test('settings default OFF and only accept the user\'s own connections in the order', () => {
  const { db, users: [a, b] } = freshDb();
  const s0 = conns.getSettings(a, db);
  assert.equal(s0.toolsEnabled, false);
  assert.equal(s0.fallbackEnabled, false);
  conns.connectProvider(a, { catalogId: 'groq', apiKey: KEY }, db);
  conns.connectProvider(b, { catalogId: 'xai', apiKey: KEY }, db);
  const s = conns.updateSettings(a, {
    toolsEnabled: true, fallbackEnabled: true,
    fallbackOrder: [{ provider: 'custom:cat-xai' }, { provider: 'custom:cat-groq', model: 'llama-3.3-70b-versatile' }, { provider: 'anthropic' }],
    toolOverrides: { 'cat-groq/x': true, bad: 'yes' },
  }, db);
  assert.equal(s.toolsEnabled, true);
  assert.deepEqual(s.fallbackOrder, [{ provider: 'custom:cat-groq', model: 'llama-3.3-70b-versatile' }]);
  assert.deepEqual(s.toolOverrides, { 'cat-groq/x': true });
  assert.equal(conns.getSettings(b, db).toolsEnabled, false, 'B is unaffected');
});

test('at most 20 connections per user', () => {
  const { db, users: [a] } = freshDb();
  for (let i = 0; i < 20; i += 1) conns.connectProvider(a, { catalogId: 'openai-compatible', slug: `s${i}`, baseURL: 'https://x.example.com/v1' }, db);
  assert.throws(() => conns.connectProvider(a, { catalogId: 'openai-compatible', slug: 'extra', baseURL: 'https://x.example.com/v1' }, db), /At most 20/);
});
