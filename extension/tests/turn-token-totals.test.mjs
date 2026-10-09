import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { newTurnTokenTotals, countTurnTokens, recordUsage } from '../kb/usage.mjs';

// The classic /code-assist turn sums every model call it makes. The calls are
// recorded on different paths and at different await depths; all of them must
// land in the turn's totals, and nothing outside the turn may.
test('countTurnTokens sums every recordUsage inside the turn, at any await depth', async () => {
  const db = new Database(':memory:');   // no usage_ledger table: the insert fails, the count must not
  const totals = newTurnTokenTotals();
  await countTurnTokens(totals, async () => {
    recordUsage(db, { userId: 'u', provider: 'deepseek', model: 'm', inputTokens: 100, outputTokens: 20 });
    await new Promise((r) => setTimeout(r, 1));
    await Promise.all([
      (async () => recordUsage(db, { userId: 'u', provider: 'deepseek', model: 'm', inputTokens: 50, outputTokens: 5, cacheReadTokens: 40 }))(),
      (async () => recordUsage(db, { provider: 'x', inputTokens: 7, outputTokens: null }))(),   // no user: still a model call
    ]);
  });
  recordUsage(db, { userId: 'u', provider: 'deepseek', model: 'm', inputTokens: 999, outputTokens: 999 }); // after the turn
  assert.deepEqual(totals, { inputTokens: 157, outputTokens: 25, cacheReadTokens: 40, cacheCreationTokens: 0, calls: 3 });
});

test('two concurrent turns keep separate totals', async () => {
  const db = new Database(':memory:');
  const a = newTurnTokenTotals();
  const b = newTurnTokenTotals();
  await Promise.all([
    countTurnTokens(a, async () => { await new Promise((r) => setTimeout(r, 2)); recordUsage(db, { inputTokens: 1, outputTokens: 1 }); }),
    countTurnTokens(b, async () => { recordUsage(db, { inputTokens: 10, outputTokens: 10 }); }),
  ]);
  assert.equal(a.inputTokens, 1);
  assert.equal(b.inputTokens, 10);
});
