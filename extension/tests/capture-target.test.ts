// Two meeting tabs open at once must not mix transcripts (2026-10 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStartTarget, makeSessionId } from '../src/lib/capture-target.ts';

const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }];

test('requested tab wins', () => {
  assert.equal(pickStartTarget(tabs, 2, 3)?.id, 2);
});

test('falls back to the active tab when the request is not a meeting tab', () => {
  assert.equal(pickStartTarget(tabs, 99, 3)?.id, 3);
  assert.equal(pickStartTarget(tabs, undefined, 1)?.id, 1);
});

test('returns null rather than fanning out to every tab', () => {
  assert.equal(pickStartTarget(tabs, undefined, 99), null);
  assert.equal(pickStartTarget([], 1, 1), null);
});

test('session ids differ across nonces with the same speaker and counter', () => {
  assert.notEqual(makeSessionId('aaaa', 'Alice', 1), makeSessionId('bbbb', 'Alice', 1));
  assert.equal(makeSessionId('aaaa', 'Alice', 1), 'aaaa-Alice-1');
});
