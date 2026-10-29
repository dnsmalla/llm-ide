// Cross-provider fallback: off by default, ordered, rate-limit aware, decided
// once at the start of a turn, always reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './provider-test-env.mjs';

const conns = await import('../server/provider-connections.mjs');
const { pickTurnProvider, noteProviderRateLimited, _clearCooldownsForTests } = await import('../providers/provider-fallback.mjs');
const { flagQuota, recordRateLimits } = await import('../kb/usage.mjs');

const KEY = 'sk-fb-0123456789abcdef';
function setup() {
  const { db, users: [a, b] } = freshDb();
  _clearCooldownsForTests();
  conns.connectProvider(a, { catalogId: 'groq', apiKey: KEY }, db);
  conns.connectProvider(a, { catalogId: 'cerebras', apiKey: KEY }, db);
  conns.connectProvider(a, { catalogId: 'deepseek', apiKey: KEY }, db);
  return { db, a, b };
}
const ORDER = [{ provider: 'custom:cat-cerebras', model: 'llama-3.3-70b' }, { provider: 'custom:cat-deepseek', model: 'deepseek-chat' }];
const REQ = { provider: 'custom:cat-groq', model: 'llama-3.3-70b-versatile' };

test('OFF by default: the requested provider is returned untouched, even when flagged', () => {
  const { db, a } = setup();
  conns.updateSettings(a, { fallbackOrder: ORDER }, db);
  flagQuota(db, a, REQ.provider, REQ.model);
  const p = pickTurnProvider(a, { ...REQ, db });
  assert.deepEqual([p.provider, p.model, p.switched], [REQ.provider, REQ.model, false]);
});

test('ON, requested provider healthy: no switch', () => {
  const { db, a } = setup();
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: ORDER }, db);
  assert.equal(pickTurnProvider(a, { ...REQ, db }).switched, false);
});

test('ON, requested provider quota-flagged: first healthy provider in the user\'s order wins, with a reason', () => {
  const { db, a } = setup();
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: ORDER }, db);
  flagQuota(db, a, REQ.provider, REQ.model);
  const p = pickTurnProvider(a, { ...REQ, db });
  assert.deepEqual([p.provider, p.model, p.switched], ['custom:cat-cerebras', 'llama-3.3-70b', true]);
  assert.match(p.reason, /quota/);
  assert.deepEqual(p.skipped, [{ provider: REQ.provider, reason: 'quota' }]);
});

test('the order is the user\'s: a flagged first choice moves on to the second', () => {
  const { db, a } = setup();
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: ORDER }, db);
  flagQuota(db, a, REQ.provider, REQ.model);
  flagQuota(db, a, 'custom:cat-cerebras', 'llama-3.3-70b');
  const p = pickTurnProvider(a, { ...REQ, db });
  assert.equal(p.provider, 'custom:cat-deepseek');
  assert.deepEqual(p.skipped.map((s) => s.reason), ['quota', 'quota']);
});

test('a recent 429 cooldown and a zero-remaining header snapshot both count as rate limited', () => {
  const { db, a } = setup();
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: ORDER }, db);
  noteProviderRateLimited(a, REQ.provider, 30_000);
  assert.equal(pickTurnProvider(a, { ...REQ, db }).provider, 'custom:cat-cerebras');
  _clearCooldownsForTests();
  recordRateLimits(a, { provider: 'custom:cat-groq', model: REQ.model, headers: { 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': new Date(Date.now() + 60_000).toISOString() } });
  const p = pickTurnProvider(a, { ...REQ, db });
  assert.equal(p.provider, 'custom:cat-cerebras');
  assert.equal(p.skipped[0].reason, 'rate_limited');
  // once the cooldown window has passed the provider is eligible again
  const later = new Date(Date.now() + 61 * 60_000);
  assert.equal(pickTurnProvider(a, { ...REQ, db, now: later }).switched, false);
});

test('a tool mode skips a fallback candidate whose model has no tools', () => {
  const { db, a } = setup();
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-deepseek', model: 'deepseek-reasoner' }, { provider: 'custom:cat-cerebras', model: 'llama-3.3-70b' }] }, db);
  flagQuota(db, a, REQ.provider, REQ.model);
  const p = pickTurnProvider(a, { ...REQ, needsTools: true, db });
  assert.equal(p.provider, 'custom:cat-cerebras');
  assert.ok(p.skipped.some((s) => s.reason === 'no_tools'));
  // without tools needed the reasoner is fine
  assert.equal(pickTurnProvider(a, { ...REQ, needsTools: false, db }).provider, 'custom:cat-deepseek');
});

test('an entry with no model gets the first tool-capable catalog model; a disconnected or keyless entry is skipped', () => {
  const { db, a } = setup();
  conns.connectProvider(a, { catalogId: 'xai', apiKey: KEY }, db);
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: [{ provider: 'custom:cat-xai' }] }, db);
  flagQuota(db, a, REQ.provider, REQ.model);
  assert.equal(pickTurnProvider(a, { ...REQ, needsTools: true, db }).model, 'grok-4');
  db.prepare('DELETE FROM user_secrets WHERE user_id=? AND secret_key=?').run(a, 'custom.cat-xai.apiKey');
  const p = pickTurnProvider(a, { ...REQ, db });
  assert.equal(p.switched, false);
  assert.equal(p.exhausted, true, 'nothing eligible: run on the requested provider and let its own error be the answer');
  assert.ok(p.skipped.some((s) => s.reason === 'no_key'));
});

test('state is per user: another user\'s flag does not move this user, and B has no fallback list', () => {
  const { db, a, b } = setup();
  conns.updateSettings(a, { fallbackEnabled: true, fallbackOrder: ORDER }, db);
  flagQuota(db, b, REQ.provider, REQ.model);
  assert.equal(pickTurnProvider(a, { ...REQ, db }).switched, false);
  assert.equal(pickTurnProvider(b, { ...REQ, db }).switched, false);
});
