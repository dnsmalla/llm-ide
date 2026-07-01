// The read-tool result cache keys on a STABLE serialization of the args, so
// the same call with differently-ordered keys is a cache hit. Previously this
// stability silently depended on validateArgs reconstructing args in schema
// order; stableStringify makes it self-contained.

import test from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify } from '../llm_agent/runtime/loop.mjs';

test('stableStringify: object key order does not change the output', () => {
  assert.equal(
    stableStringify({ a: 1, b: 2 }),
    stableStringify({ b: 2, a: 1 }),
    'reordered top-level keys must serialize identically',
  );
});

test('stableStringify: nested object keys are sorted at every depth', () => {
  assert.equal(
    stableStringify({ outer: { x: 1, y: 2 }, z: 3 }),
    stableStringify({ z: 3, outer: { y: 2, x: 1 } }),
  );
});

test('stableStringify: array element order IS preserved (semantically meaningful)', () => {
  assert.notEqual(stableStringify(['a', 'b']), stableStringify(['b', 'a']));
});

test('stableStringify: primitives and null serialize like JSON', () => {
  assert.equal(stableStringify(5), '5');
  assert.equal(stableStringify('hi'), '"hi"');
  assert.equal(stableStringify(true), 'true');
  assert.equal(stableStringify(null), 'null');
});
