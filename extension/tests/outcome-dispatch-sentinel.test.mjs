// Regression test: the dispatch sentinel must never leak into outcome
// polling. dispatcher.mjs claims a task by writing the sentinel value
// '__dispatching__' (plus a claimedAt timestamp) into meta.dispatched.url
// BEFORE the real network call, then overwrites it with the real ticket
// url on success (or releases it on failure). The outcome watcher's
// listDispatchedTasks()/listUsersWithDispatchedTasks() previously matched
// on `json_extract(meta, '$.dispatched.url') IS NOT NULL`, which also
// matches the sentinel string — so a task claimed but not yet dispatched
// (e.g. mid-flight, or stuck after a crash before release) could get
// polled by the outcome watcher, which would then try to poll the literal
// string '__dispatching__' as a provider URL and record a spurious
// "unknown" outcome for a task that was never actually dispatched.
//
// Fix: both queries now explicitly exclude the sentinel value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_outcome-dispatch-sentinel-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { listDispatchedTasks, listUsersWithDispatchedTasks } = await import('../kb/outcomes.mjs');

let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `sentinel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'sentinel',
  }).id;
}

function seedPlan() {
  reset();
  return db.savePlan(U, {
    id: 'plan1',
    title: 'Q3 plan',
    tasks: [
      { id: 't1', title: 'In-flight task', owner: 'Alice' },
      { id: 't2', title: 'Really dispatched task', owner: 'Bob' },
    ],
  });
}

test('listDispatchedTasks excludes a task still holding the dispatch sentinel', () => {
  seedPlan();
  // t1 is mid-dispatch: claimTaskForDispatch has written the sentinel but
  // the real network call has not resolved yet.
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true);
  // t2 has a real, completed dispatch.
  db.mergeTaskMeta(U, 't2', {
    dispatched: { provider: 'github', url: 'https://github.com/acme/repo/issues/5', number: 5 },
  });

  const rows = listDispatchedTasks(U);
  const ids = rows.map((r) => r.id);
  assert.ok(!ids.includes('t1'), `sentinel-holding task must be excluded, got: ${ids.join(', ')}`);
  assert.ok(ids.includes('t2'), 'really-dispatched task must be included');
});

test('listDispatchedTasks includes the task again once the sentinel is overwritten by a real url', () => {
  seedPlan();
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true);
  assert.ok(!listDispatchedTasks(U).map((r) => r.id).includes('t1'));

  // Simulate a successful dispatch completing: the real url overwrites the sentinel.
  db.mergeTaskMeta(U, 't1', {
    dispatched: { provider: 'github', url: 'https://github.com/acme/repo/issues/9', number: 9 },
  });
  const ids = listDispatchedTasks(U).map((r) => r.id);
  assert.ok(ids.includes('t1'), 'task must become pollable once it has a real dispatched url');
});

test('listUsersWithDispatchedTasks excludes a user whose only dispatched task is mid-flight', () => {
  seedPlan();
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true);
  // t2 has no dispatch at all yet.
  const userIds = listUsersWithDispatchedTasks();
  assert.ok(!userIds.includes(U), 'user with only an in-flight sentinel must not be polled');
});

test('listUsersWithDispatchedTasks includes a user once at least one task has a real dispatched url', () => {
  seedPlan();
  assert.equal(db.claimTaskForDispatch(U, 't1', '__dispatching__'), true);
  db.mergeTaskMeta(U, 't2', {
    dispatched: { provider: 'backlog', url: 'https://space.backlog.com/view/PROJ-1', number: 'PROJ-1' },
  });
  const userIds = listUsersWithDispatchedTasks();
  assert.ok(userIds.includes(U), 'user with a real dispatched task must be polled');
});
