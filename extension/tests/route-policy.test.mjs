import { test } from 'node:test';
import assert from 'node:assert/strict';
const p = await import('../providers/route-policy.mjs');

const T0 = new Date('2026-10-30T10:00:00.000Z');
const at = (ms) => new Date(T0.getTime() + ms).toISOString();

test('TTL table: Anthropic 5 min (1 h extended), assumed rows are marked, Ollama has none, unknown ids default', () => {
  assert.deepEqual(p.cacheTtl('anthropic'), { ms: 5 * 60_000, source: 'user_figure' });
  assert.equal(p.cacheTtl('claude', { extended: true }).ms, 60 * 60_000);
  assert.equal(p.cacheTtl('custom:cat-openrouter').source, 'user_figure');
  for (const id of ['openai', 'google', 'deepseek', 'groq', 'xai', 'mistral', 'together', 'cerebras']) {
    assert.deepEqual(p.cacheTtl(`custom:cat-${id}`), { ms: 10 * 60_000, source: 'assumed' }, id);
  }
  assert.equal(p.cacheTtl('custom:cat-ollama').ms, 0);
  assert.deepEqual(p.cacheTtl('custom:11111111'), { ms: 10 * 60_000, source: 'assumed' });
});

test('an unpinned chat follows the request; a pinned chat keeps its pin whatever the client asks', () => {
  const free = p.pickRoute({ route: null, requested: { provider: 'anthropic', model: 'a' }, now: T0 });
  assert.deepEqual([free.provider, free.model, free.source, free.pinned], ['anthropic', 'a', 'request', false]);
  const route = { pinned: true, provider: 'custom:cat-groq', model: 'g', warm: {} };
  const r = p.pickRoute({ route, requested: { provider: 'anthropic', model: 'a' }, now: T0 });
  assert.deepEqual([r.provider, r.model, r.source], ['custom:cat-groq', 'g', 'route']);
});

test('warm expiry NEVER changes the pick (Q-R3); it only marks the next turn cold', () => {
  const route = { pinned: true, provider: 'anthropic', model: 'a', warm: { 'anthropic|a': at(0) } };
  const later = new Date(T0.getTime() + 3 * 3600_000);
  const r = p.pickRoute({ route, requested: { provider: 'custom:cat-groq', model: 'g' }, now: later });
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.cold, true);
  assert.equal(r.coldReason, 'expired');
  const warmNow = p.pickRoute({ route, requested: { provider: 'x', model: 'y' }, now: new Date(T0.getTime() + 60_000) });
  assert.equal(warmNow.cold, false);
});

test('a provider change since the last turn asks for a fresh SDK session; a model change within Claude does not', () => {
  const route = { pinned: true, provider: 'anthropic', model: 'b', warm: { 'custom:cat-groq|g': at(0) } };
  assert.equal(p.pickRoute({ route, requested: {}, now: T0 }).freshSession, true);
  const sameFamily = { pinned: true, provider: 'anthropic', model: 'b', warm: { 'anthropic|a': at(0) } };
  const r = p.pickRoute({ route: sameFamily, requested: {}, now: T0 });
  assert.equal(r.freshSession, false);
  assert.equal(r.cold, true, 'a new model has a cold cache');
  assert.equal(r.coldReason, 'switch');
});

test('clock skew: a stamp from the future is not trusted as warm; one within a minute is', () => {
  const warm = { 'anthropic|a': at(10 * 3600_000) };
  assert.equal(p.isWarm(warm, 'anthropic', 'a', T0), false);
  assert.equal(p.isWarm({ 'anthropic|a': at(30_000) }, 'anthropic', 'a', T0), true);
  assert.equal(p.isWarm({ 'anthropic|a': 'garbage' }, 'anthropic', 'a', T0), false);
  assert.equal(p.isWarm({}, 'custom:cat-ollama', 'm', T0), false, 'no stickiness for a local cache');
});

test('switch cost: warm target is free, cold target costs the handoff and never more than the context', () => {
  const route = { warm: { 'anthropic|a': at(-60_000) } };
  assert.deepEqual(p.switchCost({ route, target: { provider: 'anthropic', model: 'a' }, now: T0 }), { cold: false, estimatedPrefillTokens: 0 });
  assert.equal(p.switchCost({ route, target: { provider: 'x', model: 'y' }, contextTokens: 90_000, now: T0 }).estimatedPrefillTokens, 1500);
  assert.equal(p.switchCost({ route, target: { provider: 'x', model: 'y' }, contextTokens: 400, now: T0 }).estimatedPrefillTokens, 400);
});

test('cap state: unlimited, under, at and over the limit; warn at 80 percent', () => {
  assert.equal(p.capState(null).blocked, false);
  assert.equal(p.capState({ tokenLimit: null, used: { billable: 9e9 } }).blocked, false);
  assert.deepEqual(p.capState({ tokenLimit: 100, used: { billable: 79 } }), { blocked: false, used: 79, limit: 100, remaining: 21, warn80: false });
  assert.equal(p.capState({ tokenLimit: 100, used: { billable: 80 } }).warn80, true);
  assert.equal(p.capState({ tokenLimit: 100, used: { billable: 100 } }).blocked, true);
  assert.equal(p.capState({ tokenLimit: 100, used: { billable: 150 } }).remaining, 0);
});

test('last_engine adapter forces a fresh Claude session; a pick that stays on an adapter does not', () => {
  const claudePick = p.pickRoute({ route: { pinned: true, provider: 'anthropic', model: 'a', warm: {}, lastEngine: 'adapter' }, requested: {}, now: T0 });
  assert.equal(claudePick.freshSession, true);
  const adapterPick = p.pickRoute({ route: { pinned: true, provider: 'custom:cat-groq', model: 'g', warm: {}, lastEngine: 'adapter' }, requested: {}, now: T0 });
  assert.equal(adapterPick.freshSession, false);
  assert.equal(p.pickRoute({ route: { pinned: true, provider: 'anthropic', model: 'a', warm: {}, lastEngine: 'claude' }, requested: {}, now: T0 }).freshSession, false);
});

test('a null model is the empty model everywhere in the pick', () => {
  const route = { pinned: false, warm: { 'anthropic|': at(0) } };
  const r = p.pickRoute({ route, requested: { provider: 'anthropic', model: null }, now: new Date(T0.getTime() + 1000) });
  assert.equal(r.changed, false);
  assert.equal(r.cold, false);
});
