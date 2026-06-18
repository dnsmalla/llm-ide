// validateArgs — schema validation for tool-call fences.
// Covers the new string[] element-count cap plus the core type/length
// guards that keep a forged fence from smuggling oversized/typed args.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../llm_agent/runtime/fence.mjs';

test('validateArgs: accepts valid typed args', () => {
  const { value, error } = validateArgs(
    { q: { type: 'string' }, n: { type: 'number' }, on: { type: 'boolean' } },
    { q: 'hi', n: 3, on: true },
  );
  assert.equal(error, undefined);
  assert.deepEqual(value, { q: 'hi', n: 3, on: true });
});

test('validateArgs: rejects missing required arg', () => {
  const { error } = validateArgs({ q: { type: 'string', required: true } }, {});
  assert.match(error, /missing required argument 'q'/);
});

test('validateArgs: enforces string maxLength', () => {
  const { error } = validateArgs({ q: { type: 'string', maxLength: 3 } }, { q: 'abcd' });
  assert.match(error, /exceeds maxLength 3/);
});

test('validateArgs: string[] enforces per-element maxLength', () => {
  const { error } = validateArgs(
    { tags: { type: 'string[]', maxLength: 2 } },
    { tags: ['ok', 'toolong'] },
  );
  assert.match(error, /tags\[1\]' exceeds maxLength 2/);
});

test('validateArgs: string[] rejects array over default maxItems (512)', () => {
  const big = Array.from({ length: 513 }, () => 'x');
  const { error } = validateArgs({ tags: { type: 'string[]' } }, { tags: big });
  assert.match(error, /exceeds maxItems 512/);
});

test('validateArgs: string[] honors an explicit maxItems', () => {
  const { error } = validateArgs(
    { tags: { type: 'string[]', maxItems: 2 } },
    { tags: ['a', 'b', 'c'] },
  );
  assert.match(error, /exceeds maxItems 2/);
});

test('validateArgs: string[] within limits passes', () => {
  const { value, error } = validateArgs(
    { tags: { type: 'string[]', maxItems: 3, maxLength: 5 } },
    { tags: ['a', 'bb'] },
  );
  assert.equal(error, undefined);
  assert.deepEqual(value, { tags: ['a', 'bb'] });
});
