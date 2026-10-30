// Argument checks of the provider-turn tool bridge (the live validator that replaced the classic loop's
// validateArgs), including the `object` type the decide tool's `questions` argument uses, and the size
// bound the decide handler's own validator puts on that object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './provider-test-env.mjs';

const { checkArgs } = await import('../llm_agent/adapter/tool-bridge.mjs');
const { validateJevQuestions } = await import('../providers/jev.mjs');

const schema = { q: { type: 'object', required: true }, note: { type: 'string', maxLength: 5 }, mode: { type: 'string', enum: ['a', 'b'] } };

test('the object type accepts a plain object and refuses arrays, strings, and a missing or null required value', () => {
  assert.equal(checkArgs(schema, { q: { a: 1 } }), null);
  assert.match(checkArgs(schema, { q: [1] }), /must be a object/);
  assert.match(checkArgs(schema, { q: 'str' }), /must be a object/);
  assert.match(checkArgs(schema, { q: null }), /missing required argument "q"/);
  assert.match(checkArgs(schema, {}), /missing required argument "q"/);
  assert.match(checkArgs(schema, null), /arguments must be an object/);
  assert.match(checkArgs(schema, [1]), /arguments must be an object/);
});

test('string length and enum bounds still apply', () => {
  assert.match(checkArgs(schema, { q: {}, note: 'toolong' }), /longer than 5/);
  assert.match(checkArgs(schema, { q: {}, mode: 'c' }), /must be one of a, b/);
});

test('decide questions: the handler validator refuses a non-object and an oversized object (the bridge does not cap size)', () => {
  assert.throws(() => validateJevQuestions([1]), /must be an object/);
  assert.throws(() => validateJevQuestions('str'), /must be an object/);
  assert.throws(() => validateJevQuestions({ q1: { type: 'text', instructions: 'x'.repeat(200_000) } }), /exceed|exceeds/);
});
