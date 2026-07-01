import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryConsume, _resetForTests } from '../server/rate-limit.mjs';

test('llm bucket allows burst then 429s', () => {
  _resetForTests();
  // Profile `llm` has capacity 3, refillRate 1/30 sec.
  assert.equal(tryConsume('llm', 'u1').ok, true);
  assert.equal(tryConsume('llm', 'u1').ok, true);
  assert.equal(tryConsume('llm', 'u1').ok, true);
  const denied = tryConsume('llm', 'u1');
  assert.equal(denied.ok, false);
  assert.ok(denied.retryAfterSec >= 1);
});

test('different profiles have independent buckets', () => {
  _resetForTests();
  for (let i = 0; i < 3; i += 1) tryConsume('llm', 'u1');
  assert.equal(tryConsume('llmFast', 'u1').ok, true, 'llmFast unaffected by llm exhaustion');
});

test('unknown profile is unlimited (no-op)', () => {
  _resetForTests();
  for (let i = 0; i < 100; i += 1) {
    assert.equal(tryConsume('does-not-exist', 'u1').ok, true);
  }
});

test('kbWrite bucket has higher capacity than llm', () => {
  _resetForTests();
  let allowed = 0;
  for (let i = 0; i < 30; i += 1) {
    if (tryConsume('kbWrite', 'u1').ok) allowed += 1;
  }
  assert.ok(allowed >= 20, `kbWrite should allow many bursts, got ${allowed}`);
});

test('per-user buckets are isolated', () => {
  _resetForTests();
  // Drain user A's llm bucket completely.
  for (let i = 0; i < 4; i += 1) tryConsume('llm', 'userA');
  // User B has a fresh bucket.
  assert.equal(tryConsume('llm', 'userB').ok, true);
  assert.equal(tryConsume('llm', 'userB').ok, true);
});

test('liveAppend profile allows high burst then throttles', () => {
  _resetForTests();
  // Profile has capacity 30, refillRate 5/sec.
  let allowed = 0;
  for (let i = 0; i < 35; i += 1) {
    if (tryConsume('liveAppend', 'u1').ok) allowed += 1;
  }
  // Should allow exactly 30 (burst) then start denying.
  assert.equal(allowed, 30, `liveAppend burst should be 30, got ${allowed}`);
  const denied = tryConsume('liveAppend', 'u1');
  assert.equal(denied.ok, false, 'liveAppend should deny when burst exhausted');
  assert.ok(denied.retryAfterSec >= 1, 'retryAfterSec should be ≥1');
});

test('tryConsume returns remaining count on success', () => {
  _resetForTests();
  const r = tryConsume('liveAppend', 'u2');
  assert.equal(r.ok, true);
  assert.ok(typeof r.remaining === 'number', 'remaining should be a number');
  assert.ok(r.remaining >= 0);
});
