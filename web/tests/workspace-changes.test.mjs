import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel } from '../src/workspace/model.ts';

test('porcelain states map to short labels', () => {
  assert.equal(statusLabel(' ', 'M'), 'M');
  assert.equal(statusLabel('M', ' '), 'M');
  assert.equal(statusLabel('A', ' '), 'A');
  assert.equal(statusLabel('D', ' '), 'D');
  assert.equal(statusLabel('?', '?'), 'U');
  assert.equal(statusLabel('R', ' '), 'R');
});
