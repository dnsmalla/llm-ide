import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PENDING_FINALIZE_BYTES_PER_USER, MAX_PENDING_FINALIZE_BYTES_TOTAL,
  finalizeBytes, byteCapRefusal,
} from '../server/finalize-budget.mjs';

test('a pending finalize is refused over its per-user byte budget', () => {
  const mb = 1024 * 1024;
  assert.equal(byteCapRefusal(31 * mb, 1 * mb, MAX_PENDING_FINALIZE_BYTES_PER_USER, MAX_PENDING_FINALIZE_BYTES_TOTAL), null);
  assert.equal(byteCapRefusal(32 * mb, 1, MAX_PENDING_FINALIZE_BYTES_PER_USER, MAX_PENDING_FINALIZE_BYTES_TOTAL), 'per_user');
});

test('the process-wide budget is stricter than four users each at their cap', () => {
  const mb = 1024 * 1024;
  assert.equal(byteCapRefusal(127 * mb, 1 * mb, MAX_PENDING_FINALIZE_BYTES_TOTAL, MAX_PENDING_FINALIZE_BYTES_TOTAL), null);
  assert.equal(byteCapRefusal(128 * mb, 1, MAX_PENDING_FINALIZE_BYTES_TOTAL, MAX_PENDING_FINALIZE_BYTES_TOTAL), 'per_user');
});

test('bytes are counted as UTF-8 JSON, not characters', () => {
  assert.ok(finalizeBytes([{ text: '日本' }]) > 6);
  assert.equal(finalizeBytes([{ text: 'abc' }]), Buffer.byteLength('[{"text":"abc"}]'));
});
