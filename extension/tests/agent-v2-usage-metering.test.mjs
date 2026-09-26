// Token metering for the Agent engine and the claude -p fallback.
//
// A v2 turn's totals must come from the SDK's own per-model accounting
// (result.modelUsage): streamed, each content block arrives as its own
// assistant message carrying the SAME usage snapshot, so summing them counted
// cache reads ~3x over and caught only a partial output count. The CLI
// fallback (mode classifier, memory extraction) used to meter runs with no
// tokens at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-usage-metering-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn, normalizeModelUsage } = await import('../llm_agent/sdk/engine.mjs');
const { ledgerRowsForTurn } = await import('../routes/agent-v2.mjs');
const { parseCliJsonResult } = await import('../providers/runtime.mjs');

function scriptedQuery({ sessionId, modelUsage }) {
  return () => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: sessionId, tools: [], capabilities: [] };
    // Streamed: two content blocks of ONE API response, each its own
    // assistant message carrying the SAME usage snapshot.
    for (let i = 0; i < 2; i++) {
      yield { type: 'assistant', session_id: sessionId,
        message: { id: 'msg_1', content: [], usage: { input_tokens: 3, output_tokens: 1,
          cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 } } };
    }
    yield { type: 'result', subtype: 'success', session_id: sessionId, ...(modelUsage ? { modelUsage } : {}) };
  })();
}

function turn({ resume = null, ...script }) {
  return runAgentV2Turn({
    message: 'hi', userId: 'u-meter', mode: 'execute',
    agentContext: { workspaceRoot: process.cwd() },
    resumeSdkSessionId: resume,
    allowAmbientAuth: true, onEvent: () => {},
    queryFactory: scriptedQuery(script),
  }, { readSkill: () => null, roots: () => [], sessionMemory: () => [], persistMemory: async () => null });
}

test('usage totals come from result.modelUsage, not from summing streamed messages', async () => {
  const { usageTotals } = await turn({
    sessionId: 'sdk-u1',
    modelUsage: {
      'claude-opus-5': { inputTokens: 3, outputTokens: 420, cacheReadInputTokens: 1000, cacheCreationInputTokens: 100, costUSD: 0.02 },
      'claude-haiku-4-5': { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0001 },
    },
  });
  // The two streamed messages alone would have summed to 2000 cache reads.
  assert.equal(usageTotals.cacheReadTokens, 1000);
  assert.equal(usageTotals.outputTokens, 425);
  assert.equal(usageTotals.byModel.length, 2);
});

test('without modelUsage the streamed fallback counts each API response once', async () => {
  const { usageTotals } = await turn({ sessionId: 'sdk-u2' });
  // Two content blocks of one response (msg_1) carry the same snapshot.
  assert.equal(usageTotals.cacheReadTokens, 1000);
  assert.equal(usageTotals.byModel, undefined);
});

// Since SDK 0.3.277 a resumed session's modelUsage is the chat's RUNNING
// total: metering it as-is would count every earlier turn again each turn.
test('a resumed turn meters the difference from where its session last ended', async () => {
  const opus = (inp, out, cr, cw) => ({ 'claude-opus-5': { inputTokens: inp, outputTokens: out, cacheReadInputTokens: cr, cacheCreationInputTokens: cw, costUSD: 0 } });
  const first = await turn({ sessionId: 'sdk-r1', modelUsage: opus(10, 100, 5000, 2000) });
  assert.equal(first.usageTotals.outputTokens, 100, 'a fresh session starts from zero');
  const second = await turn({ resume: 'sdk-r1', sessionId: 'sdk-r1', modelUsage: opus(13, 160, 12000, 2300) });
  assert.deepEqual(
    [second.usageTotals.inputTokens, second.usageTotals.outputTokens, second.usageTotals.cacheReadTokens, second.usageTotals.cacheCreationTokens],
    [3, 60, 7000, 300], 'only this turn, not the chat so far');
});

test('a resumed turn with no baseline (server restarted) falls back to its streamed usage', async () => {
  const { usageTotals } = await turn({
    resume: 'sdk-unknown', sessionId: 'sdk-unknown',
    modelUsage: { 'claude-opus-5': { inputTokens: 999, outputTokens: 99999, cacheReadInputTokens: 9_000_000, cacheCreationInputTokens: 0 } },
  });
  assert.equal(usageTotals.cacheReadTokens, 1000, 'the streamed response, not the whole chat');
  assert.equal(usageTotals.byModel, undefined);
});

test('usageDelta: a model whose running total went down (a /clear) is taken whole', async () => {
  const { usageDelta } = await import('../llm_agent/sdk/usage-baseline.mjs');
  const row = (model, o) => ({ model, inputTokens: 0, outputTokens: o, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
  assert.deepEqual(usageDelta([row('a', 50)], [row('a', 20)]), [{ ...row('a', 30) }]);
  assert.deepEqual(usageDelta([row('a', 5)], [row('a', 20)]), [row('a', 5)]);
  assert.deepEqual(usageDelta([row('a', 20), row('b', 7)], [row('a', 20)]), [row('b', 7)], 'unchanged models drop out');
});

test('normalizeModelUsage drops malformed entries and never meters a negative', () => {
  assert.deepEqual(normalizeModelUsage(null), []);
  assert.deepEqual(normalizeModelUsage({ x: null }), []);
  assert.deepEqual(normalizeModelUsage({ m: { inputTokens: -5, outputTokens: 2 } }), [
    { model: 'm', inputTokens: 0, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
  ]);
});

test('ledgerRowsForTurn: the main model carries the turn, others are metered as internal', () => {
  const byModel = normalizeModelUsage({
    'claude-opus-5[1m]': { inputTokens: 1, outputTokens: 400, cacheReadInputTokens: 900, cacheCreationInputTokens: 90 },
    'claude-haiku-4-5': { inputTokens: 50, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  });
  const rows = ledgerRowsForTurn('claude-opus-5', { byModel });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].model, rows[0].endpoint, rows[0].outputTokens], ['claude-opus-5', '/agent/v2/stream', 400]);
  assert.deepEqual([rows[1].model, rows[1].endpoint], ['claude-haiku-4-5', '/agent/v2/stream:internal']);
  // No per-model data: the single summed row it always was.
  assert.deepEqual(ledgerRowsForTurn('m', { inputTokens: 1, outputTokens: 2 }).map((r) => r.endpoint), ['/agent/v2/stream']);
});

test('parseCliJsonResult reads the CLI result object and falls back on anything else', () => {
  const out = JSON.stringify({
    type: 'result', result: 'pong', is_error: false,
    usage: { input_tokens: 397, output_tokens: 63 },
    modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 397, outputTokens: 63, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  });
  assert.deepEqual(parseCliJsonResult(out), { text: 'pong', usage: [
    { model: 'claude-haiku-4-5-20251001', inputTokens: 397, outputTokens: 63, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ] });
  assert.equal(parseCliJsonResult('plain text reply'), null);
  assert.equal(parseCliJsonResult('{"not":"a result"}'), null);
  assert.equal(parseCliJsonResult('{broken'), null);
});
