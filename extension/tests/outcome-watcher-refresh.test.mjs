// refreshAllOutcomes() is the function the server-side background outcome
// poller (agents/outcome-watcher.mjs → startBackgroundOutcomePoller, a
// setInterval "scheduled task" that runs every LLMIDE_OUTCOME_POLL_MS, default
// 5 min) calls on every tick for every user with dispatched tasks. Despite
// gating task-status correctness (terminal outcomes flip plan_tasks.status,
// e.g. a merged PR → 'done') and the per-provider circuit breaker that decides
// whether a scheduled tick even attempts a poll, it had zero direct test
// coverage — only a URL-parsing helper (outcome-url-parse.test.mjs) and the
// DB-layer recordOutcome scoping (kb-task-update-outcome-scope.test.mjs) were
// covered. This file closes that gap for the two highest-value paths:
//   1. a terminal outcome ('merged') recorded through the real poll path
//      auto-syncs the task's status to 'done' (money/correctness: this is
//      the mechanism that keeps the plan board honest without a client open).
//   2. the circuit breaker opens after CB_FAILURE_THRESHOLD (3) consecutive
//      poll failures for a provider+user and skips the next poll instead of
//      hammering a dead endpoint — the exact behavior a 5-minute scheduled
//      tick relies on to not burn the user's rate-limit quota.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_outcome-watcher-refresh-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { refreshAllOutcomes } = await import('../agents/outcome-watcher.mjs');

let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `outwatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'outwatch',
  }).id;
}

// Seed a plan task and mark it dispatched to a fake GitHub PR, mirroring
// what agents/dispatcher.mjs writes via mergeTaskMeta({ dispatched }).
function seedDispatchedTask(id = 't1') {
  db.savePlan(U, { id: 'plan1', title: 'Plan', tasks: [{ id, title: 'Ship it', status: 'in_progress' }] });
  db.mergeTaskMeta(U, id, {
    dispatched: {
      provider: 'github',
      url: 'https://github.com/acme/widgets/pull/42',
      number: 42,
      dispatchedAt: new Date().toISOString(),
    },
  });
  return id;
}

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => handler(String(url), opts);
  return () => { globalThis.fetch = original; };
}

test('refreshAllOutcomes: a merged PR is recorded and auto-syncs task status to done', async () => {
  reset();
  const taskId = seedDispatchedTask();

  const restore = mockFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ merged: true, state: 'closed', labels: [], merged_at: new Date().toISOString() }),
  }));
  let result;
  try {
    result = await refreshAllOutcomes(U, { creds: { github: { token: 'gh-test' } } });
  } finally { restore(); }

  assert.equal(result.pollCount, 1);
  assert.equal(result.changedCount, 1, 'a fresh terminal outcome should count as changed');
  assert.equal(result.polled[0].state, 'merged');

  const task = db.getTaskById(U, taskId);
  assert.equal(task.status, 'done', 'a merged PR outcome must auto-sync plan_tasks.status to done');

  const outcomes = db.listOutcomesForTask(U, taskId);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, 'merged');
  assert.equal(outcomes[0].isTerminal, true);
});

test('refreshAllOutcomes: circuit breaker opens after repeated failures and skips the next scheduled poll', async () => {
  reset();
  const taskId = seedDispatchedTask();

  // Three consecutive failures (CB_FAILURE_THRESHOLD) trip the breaker for
  // this provider+user pair.
  const failing = mockFetch(async () => ({ ok: false, status: 500 }));
  try {
    for (let i = 0; i < 3; i++) {
      const r = await refreshAllOutcomes(U, { creds: { github: { token: 'gh-test' } } });
      assert.equal(r.polled[0].state, 'unknown');
    }
  } finally { failing(); }

  // Next tick: even though the endpoint would now succeed, the breaker is
  // open, so refreshAllOutcomes must short-circuit WITHOUT calling fetch —
  // this is what protects the user's rate-limit quota on the 5-minute
  // scheduled poll.
  let fetchCalled = false;
  const succeeding = mockFetch(async () => {
    fetchCalled = true;
    return { ok: true, status: 200, json: async () => ({ merged: true, state: 'closed' }) };
  });
  let result;
  try {
    result = await refreshAllOutcomes(U, { creds: { github: { token: 'gh-test' } } });
  } finally { succeeding(); }

  assert.equal(fetchCalled, false, 'circuit breaker should skip the network call while open');
  assert.equal(result.polled[0].state, 'unknown');
  assert.equal(result.polled[0].circuitOpen, true);

  // Task must remain unsynced — nothing terminal was ever actually observed.
  const task = db.getTaskById(U, taskId);
  assert.notEqual(task.status, 'done');
});
