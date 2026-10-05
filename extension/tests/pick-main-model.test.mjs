// Which entry of the SDK's per-model totals is "the" model of a run. The chat
// meter and the Loop meter share this, so a run is never counted against a helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMainModelRow } from '../kb/usage.mjs';

const rows = [
  { model: 'claude-haiku-4-5', outputTokens: 5 },
  { model: 'claude-sonnet-5', outputTokens: 400 },
];

test('exact name wins', () => {
  assert.equal(pickMainModelRow(rows, 'claude-haiku-4-5'), rows[0]);
});

test('a suffix on either side still finds the main model', () => {
  assert.equal(pickMainModelRow(rows, 'claude-sonnet-5[1m]'), rows[1], 'init has the suffix, totals do not');
  const suffixed = [{ model: 'claude-sonnet-5[1m]', outputTokens: 1 }, { model: 'claude-haiku-4-5', outputTokens: 99 }];
  // The helper produced more output, so only the name match can pick the right one.
  assert.equal(pickMainModelRow(suffixed, 'claude-sonnet-5'), suffixed[0], 'totals have the suffix, init does not');
});

test('with no usable name, the entry that produced the most output carries the run', () => {
  assert.equal(pickMainModelRow(rows, null), rows[1]);
  assert.equal(pickMainModelRow(rows, 'something-else'), rows[1]);
});

test('empty or malformed input is null, never a throw', () => {
  assert.equal(pickMainModelRow([], 'x'), null);
  assert.equal(pickMainModelRow(undefined, 'x'), null);
  assert.equal(pickMainModelRow([null, { nomodel: 1 }], 'x'), null);
});
