import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../llm_agent/runtime/fence.mjs';

const SCHEMA = {
  op: { type: 'string', required: true, enum: ['status', 'commit', 'merge_to_main'] },
  message: { type: 'string', required: false, maxLength: 500 },
};

test('validateArgs accepts an allow-listed enum value', () => {
  const r = validateArgs(SCHEMA, { op: 'commit', message: 'hi' });
  assert.equal(r.error, undefined);
  assert.equal(r.value.op, 'commit');
});

test('validateArgs rejects a value outside the enum', () => {
  const r = validateArgs(SCHEMA, { op: 'force-push' });
  assert.match(r.error || '', /must be one of/);
});

test('validateArgs still enforces required + type without enum', () => {
  assert.match(validateArgs(SCHEMA, {}).error || '', /missing required/);
  assert.match(validateArgs(SCHEMA, { op: 5 }).error || '', /must be a string/);
});
