// Concurrency guard for external dispatch. The dispatcher's
// check-then-POST-then-write sequence was not atomic: a
// retryFailedDispatches() sweep racing an approved /kb/dispatch (or two
// overlapping sweeps) could both observe no `dispatched` marker, both
// POST, and create DUPLICATE GitHub/Backlog/Linear issues for one task.
//
// The fix claims the task atomically BEFORE the network call via a
// conditional UPDATE that writes a sentinel only when no marker exists.
// These tests pin (1) the atomic claim primitive and (2) the end-to-end
// invariant: two concurrent dispatch attempts on the same task fire
// exactly ONE POST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_dispatch-concurrency-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { dispatchPlan } = await import('../agents/dispatcher.mjs');

let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `concur-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'concur',
  }).id;
}

function seedPlan() {
  reset();
  return db.savePlan(U, {
    id: 'plan1',
    title: 'Q3 plan',
    tasks: [{ id: 't1', title: 'Build API', owner: 'Alice', risk: 'high' }],
  });
}

const GH_CONFIG = { repo: 'octo/repo', token: 'ghp_testtoken' };

// Install a fetch stub that counts POSTs and holds the connection open
// long enough that a second concurrent attempt is in flight before the
// first resolves. Returns a restore() fn.
function stubGithubFetch({ status = 201, delayMs = 50 } = {}) {
  const orig = globalThis.fetch;
  const state = { posts: 0 };
  globalThis.fetch = async () => {
    state.posts += 1;
    const n = state.posts;
    await new Promise((r) => setTimeout(r, delayMs));
    return new Response(
      JSON.stringify({ html_url: `https://github.com/octo/repo/issues/${n}`, number: n, state: 'open' }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { state, restore: () => { globalThis.fetch = orig; } };
}

test('claimTaskForDispatch: only one of two simultaneous claims wins', () => {
  seedPlan();
  // Both callers took their snapshot before either marked the task —
  // exactly the retry-sweep-vs-dispatch race. The atomic CAS must let
  // only one through.
  const first  = db.claimTaskForDispatch(U, 't1', '__dispatching__');
  const second = db.claimTaskForDispatch(U, 't1', '__dispatching__');
  assert.equal(first, true, 'first claim wins');
  assert.equal(second, false, 'second claim loses');
});

test('releaseTaskDispatchClaim: clears the sentinel so a later retry can re-claim', () => {
  seedPlan();
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true);
  // A real dispatched url must NOT be released by a stale sentinel call.
  db.mergeTaskMeta(U, 't1', { dispatched: { url: 'https://github.com/octo/repo/issues/9', number: 9 } });
  db.releaseTaskDispatchClaim(U, 't1', '__dispatching__');
  assert.equal(db.getTaskById(U, 't1').meta.dispatched.url, 'https://github.com/octo/repo/issues/9',
    'release must not clobber a real url');

  // But when the task IS still holding the sentinel, release clears it.
  seedPlan();
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true);
  db.releaseTaskDispatchClaim(U, 't1', '__dispatching__');
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true, 're-claimable after release');
});

test('dispatchPlan: two concurrent dispatches of the same task fire exactly one POST', async () => {
  seedPlan();
  const fetchStub = stubGithubFetch();
  try {
    const [a, b] = await Promise.all([
      dispatchPlan(U, { planId: 'plan1', target: 'github', taskIds: ['t1'], config: GH_CONFIG }),
      dispatchPlan(U, { planId: 'plan1', target: 'github', taskIds: ['t1'], config: GH_CONFIG }),
    ]);
    assert.equal(fetchStub.state.posts, 1, 'exactly one issue POST should fire');
    const results = [...a.results, ...b.results];
    assert.equal(results.filter((r) => r.status === 'ok').length, 1, 'one ok');
    assert.equal(results.filter((r) => r.status === 'skipped').length, 1, 'one skipped');
    // The single recorded url must be the real issue url, never the sentinel.
    assert.match(db.getTaskById(U, 't1').meta.dispatched.url, /github\.com\/octo\/repo\/issues\/1/);
  } finally {
    fetchStub.restore();
  }
});

test('dispatchPlan: a failed dispatch releases the claim so a retry can re-dispatch', async () => {
  seedPlan();
  const fail = stubGithubFetch({ status: 500 });
  try {
    const res = await dispatchPlan(U, { planId: 'plan1', target: 'github', taskIds: ['t1'], config: GH_CONFIG });
    assert.equal(res.results[0].status, 'error');
    assert.equal(fail.state.posts, 1);
  } finally {
    fail.restore();
  }
  // Claim was released — a subsequent successful dispatch must go through.
  const ok = stubGithubFetch({ status: 201 });
  try {
    const res = await dispatchPlan(U, { planId: 'plan1', target: 'github', taskIds: ['t1'], config: GH_CONFIG });
    assert.equal(res.results[0].status, 'ok', 'retry re-claims and succeeds');
    assert.equal(ok.state.posts, 1);
  } finally {
    ok.restore();
  }
});
