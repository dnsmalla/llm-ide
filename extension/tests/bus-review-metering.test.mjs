// A bus review that runs the claude engine writes its usage to the ledger, like the desktop task route does.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_BUS;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_bus-review-metering-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { runReview } = await import('../routes/bus/review.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `bm-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'bm' }).id;
const REPO = '/fake/repo';
const gitOk = async (cmd, argv) => ({ code: 0, stdout: argv.includes('rev-parse') ? 'true\n' : '', stderr: '' });
const args = { focus: 'code', projectId: 'p-bus' };

// A claude engine stand-in: the review reads the repo read-only and reports what the run used.
function claudeEngine(out) {
  return {
    validateLoopRepoRoot: (u, root) => ({ ok: true, root }),
    runLoopAgent: async (a) => (typeof out === 'function' ? out(a) : { reply: 'No findings.', changedPaths: [], createdPaths: [], resultSubtype: 'success', ...out }),
  };
}
const RUN_USAGE = {
  model: 'claude-x',
  byModel: [
    { model: 'claude-helper', inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    { model: 'claude-x', inputTokens: 100, outputTokens: 20, cacheReadTokens: 7, cacheCreationTokens: 0 },
  ],
  usage: { inputTokens: 105, outputTokens: 21, cacheReadTokens: 7, cacheCreationTokens: 0, costUsd: 0.5, numTurns: 3 },
};
const busRows = (userId) => db.prepare(
  "SELECT source, endpoint, provider, model, cost_usd, turns, stop_reason, input_tokens, project_id FROM usage_ledger WHERE user_id = ? AND endpoint = 'bus:review' ORDER BY model",
).all(userId).map((r) => ({ ...r }));

after(() => {
  kb.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(tmpDb + s); } catch { /* ok */ } }
});

test('a bus review with usage writes one row per model for its own user, primary model carries turns and cost', async () => {
  const a = mkUser();
  const b = mkUser();
  const r = await runReview({
    userId: a, args, cwd: REPO, spawn: gitOk, emit: () => {},
    deps: { claudeEngine: claudeEngine(RUN_USAGE) },
  });
  assert.equal(r.text, 'No findings.');
  const [helper, primary] = busRows(a);
  // The helper row has no reported cost, so recordUsage estimates it from tokens (positive); it carries no turns.
  assert.ok(helper.cost_usd > 0);
  assert.deepEqual({ ...helper, cost_usd: null }, { source: 'bus', endpoint: 'bus:review', provider: 'anthropic', model: 'claude-helper', cost_usd: null, turns: null, stop_reason: null, input_tokens: 5, project_id: 'p-bus' });
  assert.deepEqual(primary, { source: 'bus', endpoint: 'bus:review', provider: 'anthropic', model: 'claude-x', cost_usd: 0.5, turns: 3, stop_reason: 'success', input_tokens: 100, project_id: 'p-bus' });
  assert.deepEqual(busRows(b), []);
});

test('a bus review whose run reports no usage writes no ledger rows', async () => {
  const a = mkUser();
  const r = await runReview({
    userId: a, args, cwd: REPO, spawn: gitOk, emit: () => {},
    deps: { claudeEngine: claudeEngine({}) },
  });
  assert.equal(r.text, 'No findings.');
  assert.deepEqual(busRows(a), []);
});

test('an aborted run that still reports partial usage is metered with the stop reason the engine gave', async () => {
  const a = mkUser();
  const ac = new AbortController();
  const r = await runReview({
    userId: a, args, cwd: REPO, spawn: gitOk, emit: () => {}, signal: ac.signal,
    deps: { claudeEngine: claudeEngine((req) => {
      req.abortController.abort();
      return { reply: '', changedPaths: [], createdPaths: [], resultSubtype: 'error_during_execution',
        model: 'claude-x', byModel: [{ model: 'claude-x', inputTokens: 40, outputTokens: 2 }],
        usage: { inputTokens: 40, outputTokens: 2, costUsd: 0.1, numTurns: 1 } };
    }) },
  });
  assert.equal(typeof r.text, 'string');
  const rows = busRows(a);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input_tokens, 40);
  assert.equal(rows[0].stop_reason, 'error_during_execution');
});

test('a failing ledger write never fails the review job', async () => {
  const a = mkUser();
  db.exec('ALTER TABLE usage_ledger RENAME TO usage_ledger_off');
  try {
    const r = await runReview({
      userId: a, args, cwd: REPO, spawn: gitOk, emit: () => {},
      deps: { claudeEngine: claudeEngine(RUN_USAGE) },
    });
    assert.equal(r.text, 'No findings.');
  } finally {
    db.exec('ALTER TABLE usage_ledger_off RENAME TO usage_ledger');
  }
});
