// Run recording helper (plan 2.5, Stage 1b): one agent_runs row per run, opened
// when the run starts and closed exactly once with its totals. Best-effort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const agent = await import('../kb/agent-db.mjs');
const { beginAgentRun, runTotals } = await import('../kb/agent-runs.mjs');
const { config } = await import('../core/config.mjs');

const files = [config.agentDbPath, `${config.agentDbPath}-wal`, `${config.agentDbPath}-shm`];
function fresh() {
  agent.closeAgentDb();
  for (const f of files) fs.rmSync(f, { force: true });
  const db = agent.getAgentDb();
  assert.ok(db, 'agent.db opens in tests');
  return db;
}
const row = (db, runId) => {
  agent.flushAgentQueue();
  return db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId);
};
const U = 'user-runs-1';

test('beginAgentRun opens a running row at start, with source and engine', () => {
  const db = fresh();
  const run = beginAgentRun(U, { runId: 'r-open', source: 'chat', engine: 'v2', mode: 'execute', provider: 'anthropic', model: 'm1' });
  const r = row(db, 'r-open');
  assert.equal(r.status, 'running');
  assert.equal(r.source, 'chat');
  assert.equal(r.engine, 'v2');
  assert.equal(r.mode, 'execute');
  assert.equal(r.model, 'm1');
  assert.equal(r.ended_at, null);
  run.finish({ status: 'ok' });
});

test('finish closes the run once with its totals; a second finish is a no-op', () => {
  const db = fresh();
  const run = beginAgentRun(U, { runId: 'r-close', source: 'loop', engine: 'loop' });
  assert.equal(run.finish({ status: 'ok', toolCalls: 4, inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheCreationTokens: 7, stopReason: 'success' }), true);
  assert.equal(run.finish({ status: 'error', inputTokens: 999 }), false, 'second close is refused');
  const r = row(db, 'r-close');
  assert.equal(r.status, 'ok');
  assert.equal(r.tool_calls, 4);
  assert.equal(r.input_tokens, 10);
  assert.equal(r.output_tokens, 2);
  assert.equal(r.cache_read_tokens, 5);
  assert.equal(r.cache_creation_tokens, 7);
  assert.equal(r.stop_reason, 'success');
  assert.ok(r.duration_ms >= 0);
});

test('error and cancelled closes keep the code, never a message', () => {
  const db = fresh();
  beginAgentRun(U, { runId: 'r-err', source: 'chat', engine: 'legacy' }).finish({ status: 'error', errorCode: 'ENGINE_ERROR' });
  beginAgentRun(U, { runId: 'r-cancel', source: 'meeting', engine: 'meeting' }).finish({ status: 'cancelled' });
  assert.equal(row(db, 'r-err').error_code, 'ENGINE_ERROR');
  assert.equal(row(db, 'r-cancel').status, 'cancelled');
});

test('an unknown status is recorded as error, never trusted as given', () => {
  const db = fresh();
  beginAgentRun(U, { runId: 'r-bad', source: 'chat', engine: 'v2' }).finish({ status: 'weird' });
  assert.equal(row(db, 'r-bad').status, 'error');
});

test('a bad source or missing run id never throws', () => {
  fresh();
  assert.doesNotThrow(() => beginAgentRun(U, { runId: 'r-x', source: 'nonsense' }).finish({ status: 'ok' }));
  assert.doesNotThrow(() => beginAgentRun(null, { runId: 'r-y', source: 'chat' }).finish({}));
  assert.doesNotThrow(() => beginAgentRun(U, {}).finish({}));
});

test('runTotals maps a usage object to close fields and tolerates none', () => {
  assert.deepEqual(runTotals({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }),
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, thinkingTokens: undefined });
  assert.equal(runTotals(null).inputTokens, undefined);
});

test('begin and finish return quietly after the store is closed', () => {
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  const run = beginAgentRun(U, { runId: 'r-down', source: 'chat', engine: 'v2' });
  assert.doesNotThrow(() => run.finish({ status: 'ok' }));
});

const { recordFinishedRun, withAgentRun, agentRunsInFlight } = await import('../kb/agent-runs.mjs');

test('recordFinishedRun writes one closed run, idempotent on the run id', () => {
  const db = fresh();
  assert.equal(recordFinishedRun(U, { runId: 'a1', source: 'autotask', engine: 'cli', status: 'ok', inputTokens: 5 }), true);
  recordFinishedRun(U, { runId: 'a1', source: 'autotask', engine: 'cli', status: 'ok', inputTokens: 5 });
  const r = row(db, 'a1');
  assert.equal(r.status, 'ok');
  assert.equal(r.input_tokens, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE run_id = 'a1'").get().n, 1);
});

test('withAgentRun passes the result and the error through, and always closes the run', async () => {
  const db = fresh();
  const before = agentRunsInFlight();
  assert.equal(await withAgentRun(U, { runId: 'w-ok', source: 'dispatch' }, async () => 42), 42);
  await assert.rejects(
    withAgentRun(U, { runId: 'w-err', source: 'dispatch' }, async () => { throw Object.assign(new Error('boom'), { code: 'X1' }); }),
    /boom/,
  );
  assert.equal(await withAgentRun(U, { runId: 'w-soft', source: 'dispatch' }, async () => ({ bad: true }), { status: (o) => (o.bad ? 'error' : 'ok') }).then((o) => o.bad), true);
  assert.equal(row(db, 'w-ok').status, 'ok');
  assert.equal(row(db, 'w-err').status, 'error');
  assert.equal(row(db, 'w-err').error_code, 'X1');
  assert.equal(row(db, 'w-soft').status, 'error');
  assert.equal(agentRunsInFlight(), before, 'no run left open');
});

test('concurrent runs close independently', async () => {
  const db = fresh();
  await Promise.all(Array.from({ length: 20 }, (_, i) => withAgentRun(U, { runId: `c${i}`, source: 'review' }, async () => {
    await new Promise((r) => setTimeout(r, i % 3));
    if (i % 5 === 0) throw new Error('x');
  }).catch(() => {})));
  agent.flushAgentQueue();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'error'").get().n, 4);
});

test('withAgentRun works and passes through with the store down', async () => {
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  assert.equal(await withAgentRun(U, { runId: 'down', source: 'dispatch' }, async () => 'fine'), 'fine');
  await assert.rejects(withAgentRun(U, { runId: 'down2', source: 'dispatch' }, async () => { throw new Error('real'); }), /real/);
});

test('legacy turn totals come from the running turn and fail closed when partial', async () => {
  const { newTurnTokenTotals, countTurnTokens, currentTurnTokenTotals, recordUsage, turnTokenUsageFields } = await import('../kb/usage.mjs');
  assert.equal(currentTurnTokenTotals(), null);
  const totals = newTurnTokenTotals();
  await countTurnTokens(totals, async () => {
    assert.equal(currentTurnTokenTotals(), totals);
    recordUsage(null, { userId: U, provider: 'p', model: 'm', inputTokens: 3, outputTokens: 1 });
  });
  assert.ok(turnTokenUsageFields(totals) === null || turnTokenUsageFields(totals).inputTokens === 3);
});

test('thinking tokens are a breakdown column on the run (migration 0003), 0 when absent', () => {
  const db = fresh();
  beginAgentRun(U, { runId: 'r-think', source: 'chat', engine: 'v2' })
    .finish({ status: 'ok', ...runTotals({ inputTokens: 1, outputTokens: 900, thinkingTokens: 640 }) });
  beginAgentRun(U, { runId: 'r-nothink', source: 'chat', engine: 'v2' })
    .finish({ status: 'ok', ...runTotals({ inputTokens: 1, outputTokens: 9 }) });
  assert.equal(row(db, 'r-think').thinking_tokens, 640);
  assert.equal(row(db, 'r-think').output_tokens, 900, 'output keeps the full count: thinking is inside it, not added');
  assert.equal(row(db, 'r-nothink').thinking_tokens, 0);
});
