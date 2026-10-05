// The ledger summary behind scripts/usage-report.mjs: how big a step is, how
// concentrated the cost is in a few long runs, and (migration 0039) how many
// round trips steps took and how many hit the turn cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRuns } from '../scripts/usage-report.mjs';

const row = (cacheRead, turns = null, stop = null) => ({ cache_read_tokens: cacheRead, turns, stop_reason: stop });

test('size distribution and the share held by the top fifth of runs', () => {
  // Nine small runs and one that is half of everything.
  const rows = [...Array(9)].map(() => row(100_000)).concat(row(900_000));
  const s = summarizeRuns(rows);
  assert.equal(s.runs, 10);
  assert.equal(s.median, 100_000);
  assert.equal(s.max, 900_000);
  assert.equal(Math.round(s.cacheReadM * 10) / 10, 1.8);
  // top fifth of 10 runs = 2 runs: 900k + 100k of 1.8M
  assert.ok(Math.abs(s.topFifthShare - (1_000_000 / 1_800_000)) < 1e-9);
});

test('turns are summarized only where recorded, and cap hits are counted', () => {
  const s = summarizeRuns([row(1, 5, 'success'), row(1, 12, 'success'), row(1, 60, 'error_max_turns'), row(1, null, null)]);
  assert.equal(s.runs, 4);
  assert.equal(s.turns.known, 3, 'a row without turns is unknown, not zero');
  assert.equal(s.turns.max, 60);
  assert.equal(s.turns.capped, 1);
  // A run that reached the cap without the SDK saying so still counts.
  assert.equal(summarizeRuns([row(1, 60, 'success')], { turnCap: 60 }).turns.capped, 1);
  assert.equal(summarizeRuns([row(1, 59, 'success')], { turnCap: 60 }).turns.capped, 0);
});

test('rows written before turns were recorded say so instead of showing zeros', () => {
  assert.equal(summarizeRuns([row(10), row(20)]).turns, null);
  assert.deepEqual(summarizeRuns([]), { runs: 0, cacheReadM: 0, median: 0, p90: 0, max: 0, topFifthShare: 0, turns: null });
});
