// Per-turn token budget + ledger metering of a multi-call (subagent) turn.
// Scripted/fake SDK only — no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-v2-turn-budget-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const { runAgentV2Turn, turnTokenBudget, budgetNoticeText } = await import('../llm_agent/sdk/engine.mjs');
const { ledgerRowsForTurn } = await import('../routes/agent-v2.mjs');

const inject = { readSkill: () => null, roots: () => [], sessionMemory: () => [], persistMemory: async () => null };

// A streamed API response: message_start (placeholder output), the assistant
// block message (same placeholder), message_delta (the REAL output count).
function response({ id, parent = null, input, cacheRead, cacheWrite, output }) {
  const usage = { input_tokens: input, output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
  const p = parent ? { parent_tool_use_id: parent } : {};
  return [
    { type: 'stream_event', ...p, event: { type: 'message_start', message: { id, usage } } },
    { type: 'assistant', ...p, message: { id, content: [], usage } },
    { type: 'stream_event', ...p, event: { type: 'message_delta', usage: { output_tokens: output } } },
  ];
}

function fakeQuery(messages, { withInterrupt = true } = {}) {
  const state = { interrupted: 0 };
  const factory = () => {
    let stop = false;
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-b', tools: [], capabilities: [] };
      for (const m of messages) {
        if (stop) break;
        yield m;
        if (m.type === 'assistant') await new Promise((r) => setImmediate(r));
      }
      yield { type: 'result', subtype: stop ? 'error_during_execution' : 'success', session_id: 'sdk-b', num_turns: 2, stop_reason: stop ? null : 'end_turn' };
    })();
    if (withInterrupt) gen.interrupt = async () => { state.interrupted += 1; stop = true; };
    return gen;
  };
  return { factory, state };
}

function run(messages, opts) {
  const { factory, state } = fakeQuery(messages, opts);
  const events = [];
  const p = runAgentV2Turn({
    message: 'go', userId: 'u-budget', mode: 'execute', agentContext: { workspaceRoot: process.cwd() },
    allowAmbientAuth: true, onEvent: (e) => events.push(e), queryFactory: factory,
  }, inject);
  return p.then((r) => ({ ...r, events, state }));
}

const hop = (n, extra = {}) => response({ id: `m${n}`, input: 10, cacheRead: 900_000, cacheWrite: 1000, output: 50 + n, ...extra });

test('turnTokenBudget: default 2M, 0 = off, invalid warns and defaults', () => {
  assert.equal(turnTokenBudget(undefined), 2_000_000);
  assert.equal(turnTokenBudget('0'), 0);
  assert.equal(turnTokenBudget('500000'), 500_000);
  const warn = console.warn; let warned = 0; console.warn = () => { warned += 1; };
  try {
    assert.equal(turnTokenBudget('abc'), 2_000_000);
    assert.equal(turnTokenBudget('-5'), 2_000_000);
  } finally { console.warn = warn; }
  assert.equal(warned, 2);
});

test('budgetNoticeText names processed tokens and the budget', () => {
  assert.equal(budgetNoticeText(2_100_000, 2_000_000),
    'Stopped: this turn processed 2.1M tokens (budget 2M). Say "continue" to keep going.');
});

test('a turn over the budget is interrupted, keeps its partial work, notifies, and records token_budget', async () => {
  process.env.LLMIDE_V2_TURN_TOKEN_BUDGET = '2000000';
  try {
    // 4 hops x ~901k processed: the third crosses 2M, the fourth must never run.
    const msgs = [1, 2, 3, 4].flatMap((n) => hop(n));
    const { usageTotals, events, state, result } = await run(msgs);
    assert.equal(state.interrupted, 1);
    assert.equal(usageTotals.stopReason, 'token_budget');
    assert.ok(result, 'the SDK result still arrives');
    const notice = events.find((e) => e.type === 'delta' && /Stopped: this turn processed/.test(e.text));
    assert.ok(notice, 'notice delta emitted');
    assert.match(notice.text, /\(budget 2M\)\. Say "continue" to keep going\./);
    assert.ok(events.findIndex((e) => e === notice) < events.findIndex((e) => e.type === 'result'), 'notice precedes the terminal result');
    assert.equal(events.filter((e) => e.type === 'usage').length, 1);
    assert.ok(usageTotals.cacheReadTokens < 4 * 900_000, 'the fourth hop was not consumed');
    const row = ledgerRowsForTurn('claude-opus-5', usageTotals)[0];
    assert.equal(row.stopReason, 'token_budget');
  } finally { delete process.env.LLMIDE_V2_TURN_TOKEN_BUDGET; }
});

test('budget 0 disables the stop; no interrupt even for a huge turn', async () => {
  process.env.LLMIDE_V2_TURN_TOKEN_BUDGET = '0';
  try {
    const { usageTotals, state, events } = await run([1, 2, 3, 4].flatMap((n) => hop(n)));
    assert.equal(state.interrupted, 0);
    assert.equal(usageTotals.stopReason, 'end_turn');
    assert.ok(!events.some((e) => e.type === 'delta' && /Stopped:/.test(e.text)));
  } finally { delete process.env.LLMIDE_V2_TURN_TOKEN_BUDGET; }
});

test('without q.interrupt the turn falls back to the abort controller', async () => {
  process.env.LLMIDE_V2_TURN_TOKEN_BUDGET = '1000000';
  try {
    const ac = new AbortController();
    const { factory } = fakeQuery([1, 2, 3].flatMap((n) => hop(n)), { withInterrupt: false });
    await runAgentV2Turn({
      message: 'go', userId: 'u-budget', mode: 'execute', agentContext: { workspaceRoot: process.cwd() },
      allowAmbientAuth: true, onEvent: () => {}, queryFactory: factory,
      signal: ac.signal, abortController: ac,
    }, inject);
    assert.equal(ac.signal.aborted, true);
  } finally { delete process.env.LLMIDE_V2_TURN_TOKEN_BUDGET; }
});

// The ledger row of a multi-call turn including a subagent: real output counts
// (message_delta, not the placeholder), every API call counted once, turns = calls.
test('ledger row carries input/cache/output totals and turns for a multi-call turn with a subagent', async () => {
  process.env.LLMIDE_V2_TURN_TOKEN_BUDGET = '0';
  try {
    const msgs = [
      ...response({ id: 'a1', input: 5, cacheRead: 1000, cacheWrite: 200, output: 300 }),
      ...response({ id: 's1', parent: 'toolu_task', input: 7, cacheRead: 400, cacheWrite: 0, output: 120 }),
      ...response({ id: 's2', parent: 'toolu_task', input: 3, cacheRead: 500, cacheWrite: 50, output: 80 }),
      ...response({ id: 'a2', input: 2, cacheRead: 1500, cacheWrite: 10, output: 90 }),
    ];
    const { usageTotals } = await run(msgs);
    assert.deepEqual(
      [usageTotals.inputTokens, usageTotals.outputTokens, usageTotals.cacheReadTokens, usageTotals.cacheCreationTokens],
      [17, 590, 3400, 260]);
    assert.equal(usageTotals.turns, 4, 'four API calls incl. the subagent (SDK num_turns says 2)');
    const rows = ledgerRowsForTurn('claude-opus-5', usageTotals);
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].inputTokens, rows[0].outputTokens, rows[0].cacheReadTokens, rows[0].cacheCreationTokens, rows[0].turns, rows[0].stopReason],
      [17, 590, 3400, 260, 4, 'end_turn']);
  } finally { delete process.env.LLMIDE_V2_TURN_TOKEN_BUDGET; }
});

test('with per-model usage, turns/stopReason ride the main row only', () => {
  const byModel = [
    { model: 'claude-opus-5', inputTokens: 1, outputTokens: 400, cacheReadTokens: 9, cacheCreationTokens: 1, costUsd: 0 },
    { model: 'claude-haiku-4-5', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
  ];
  const rows = ledgerRowsForTurn('claude-opus-5', { byModel, turns: 7, stopReason: 'end_turn' });
  assert.equal(rows[0].turns, 7);
  assert.equal(rows[1].turns, undefined);
  assert.equal(rows[1].stopReason, undefined);
});

test('the result usage floors a no-baseline fallback', async () => {
  process.env.LLMIDE_V2_TURN_TOKEN_BUDGET = '0';
  try {
    const wrapped = () => (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sdk-f', tools: [], capabilities: [] };
      yield { type: 'assistant', message: { id: 'x', content: [], usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } };
      yield { type: 'result', subtype: 'success', session_id: 'sdk-f', num_turns: 1, usage: { input_tokens: 2, output_tokens: 777, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } };
    })();
    const { usageTotals } = await runAgentV2Turn({
      message: 'go', userId: 'u-budget', mode: 'execute', agentContext: { workspaceRoot: process.cwd() },
      resumeSdkSessionId: 'sdk-nobaseline', allowAmbientAuth: true, onEvent: () => {}, queryFactory: wrapped,
    }, inject);
    assert.equal(usageTotals.outputTokens, 777);
  } finally { delete process.env.LLMIDE_V2_TURN_TOKEN_BUDGET; }
});
