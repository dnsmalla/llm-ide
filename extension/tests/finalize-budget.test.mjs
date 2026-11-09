import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  finalizeBytes, byteCapRefusal,
} from '../server/finalize-budget.mjs';

test('a pending finalize is refused over its per-user byte budget', () => {
  const mb = 1024 * 1024;
  assert.equal(byteCapRefusal(31 * mb, 31 * mb, 1 * mb), null);
  assert.equal(byteCapRefusal(32 * mb, 32 * mb, 1), 'per_user');
});

test('the process-wide budget is stricter than four users each at their cap', () => {
  const mb = 1024 * 1024;
  assert.equal(byteCapRefusal(0, 127 * mb, 1 * mb), null);
  assert.equal(byteCapRefusal(0, 128 * mb, 1), 'total');
});

test('bytes are counted as UTF-8 JSON, not characters', () => {
  assert.ok(finalizeBytes([{ text: '日本' }]) > 6);
  assert.equal(finalizeBytes([{ text: 'abc' }]), Buffer.byteLength('[{"text":"abc"}]'));
});
