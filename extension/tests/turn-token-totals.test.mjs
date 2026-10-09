import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const { newTurnTokenTotals, countTurnTokens, recordUsage, noteUnmeteredModelCall, turnTokenUsageFields } =
  await import('../kb/usage.mjs');
const { streamModelReply } = await import('../providers/runtime.mjs');

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
  assert.deepEqual(totals, { inputTokens: 157, outputTokens: 25, cacheReadTokens: 40, cacheCreationTokens: 0, calls: 3, unmeteredCalls: 0 });
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

test('a call that reported no tokens is an unmetered call; a poisoned count is clamped like the ledger', async () => {
  const db = new Database(':memory:');
  const totals = newTurnTokenTotals();
  await countTurnTokens(totals, async () => {
    recordUsage(db, { userId: 'u', provider: 'openai', model: 'm', inputTokens: null, outputTokens: null }); // CLI text mode
    recordUsage(db, { userId: 'u', provider: 'openai', model: 'm', inputTokens: 1e18, outputTokens: 1 });
  });
  assert.equal(totals.calls, 1);
  assert.equal(totals.unmeteredCalls, 1);
  assert.ok(totals.inputTokens < 1e18, 'clamped');
  assert.equal(totals.outputTokens, 1);
});

// A turn's total is only reported when EVERY model call in it was metered.
// Otherwise a keyless CLI turn would show the mode classifier's few hundred
// tokens as if they were the whole turn.
test('turnTokenUsageFields: no fields when any call in the turn was unmetered', async () => {
  const db = new Database(':memory:');
  const totals = newTurnTokenTotals();
  await countTurnTokens(totals, async () => {
    recordUsage(db, { userId: 'u', provider: 'anthropic', model: 'm', inputTokens: 300, outputTokens: 5 }); // classifier
    noteUnmeteredModelCall();                                                                                 // the streamed reply
  });
  assert.equal(totals.unmeteredCalls, 1);
  assert.equal(turnTokenUsageFields(totals), null);
});

test('turnTokenUsageFields: all metered → the summed fields, as before', async () => {
  const db = new Database(':memory:');
  const totals = newTurnTokenTotals();
  await countTurnTokens(totals, async () => {
    recordUsage(db, { userId: 'u', provider: 'anthropic', model: 'm', inputTokens: 300, outputTokens: 5 });
    recordUsage(db, { userId: 'u', provider: 'anthropic', model: 'm', inputTokens: 1000, outputTokens: 200, cacheReadTokens: 800, cacheCreationTokens: 50 });
  });
  assert.deepEqual(turnTokenUsageFields(totals), {
    inputTokens: 1300, outputTokens: 205, cacheReadTokens: 800, cacheCreationTokens: 50, modelCalls: 2,
  });
});

test('turnTokenUsageFields: a cache-only call counts; no calls at all → no fields', async () => {
  const db = new Database(':memory:');
  const totals = newTurnTokenTotals();
  await countTurnTokens(totals, async () => {
    recordUsage(db, { userId: 'u', provider: 'anthropic', model: 'm', inputTokens: 0, outputTokens: 0, cacheReadTokens: 900 });
  });
  assert.deepEqual(turnTokenUsageFields(totals), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 900, modelCalls: 1 });
  assert.equal(turnTokenUsageFields(newTurnTokenTotals()), null);
  assert.equal(turnTokenUsageFields(null), null);
});

test('noteUnmeteredModelCall outside a turn is a no-op', () => {
  assert.doesNotThrow(() => noteUnmeteredModelCall());
});

test('the CLI streaming reply path notes an unmetered call on the turn', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;   // keyless → CLI stream branch
  try {
    const totals = newTurnTokenTotals();
    const text = await countTurnTokens(totals, () => streamModelReply('hi', {
      provider: 'anthropic',
      _testSpawnCliStream: async (_provider, _prompt, opts) => {
        opts.onChunk?.('streamed');
        return { stdoutText: 'streamed', stderr: '', bin: 'claude' };
      },
    }));
    assert.equal(text, 'streamed');
    assert.equal(totals.calls, 0);
    assert.equal(totals.unmeteredCalls, 1);
    assert.equal(turnTokenUsageFields(totals), null);
  } finally {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
