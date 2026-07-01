// dispatchPlan preview path — deterministic, no network. Pins the
// contract the Mac client relies on before a user commits to a real
// GitHub/Backlog/Linear dispatch: title/labels/body/assignees per task,
// taskIds subset filtering, and the guard rails (unknown target,
// missing plan).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Secrets + DB path must be set before kb/db imports config (validated
// at load time).
process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_dispatch-preview-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const { dispatchPlan } = await import('../agents/dispatcher.mjs');

let U; // real user id — plans.user_id has a FK to users

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'dispatch',
  }).id;
}

function seedPlan() {
  reset();
  return db.savePlan(U, {
    id: 'plan1',
    title: 'Q3 plan',
    tasks: [
      { id: 't1', title: 'Build API', owner: 'Alice', risk: 'high' },
      { id: 't2', title: 'Write docs', owner: 'Bob' },
    ],
  });
}

test('dispatchPlan preview: returns one preview result per task', async () => {
  seedPlan();
  const res = await dispatchPlan(U, { planId: 'plan1', target: 'preview' });
  assert.equal(res.target, 'preview');
  assert.equal(res.plan.id, 'plan1');
  assert.equal(res.results.length, 2);
  assert.ok(res.results.every((r) => r.status === 'preview'));
});

test('dispatchPlan preview: maps title, risk label, and owner into the body', async () => {
  seedPlan();
  const { results } = await dispatchPlan(U, { planId: 'plan1', target: 'preview' });
  const t1 = results.find((r) => r.taskId === 't1');
  assert.match(t1.title, /Build API/);
  assert.deepEqual(t1.labels, ['risk:high']);
  assert.equal(typeof t1.body, 'string');
  assert.match(t1.body, /Alice/); // buildBody surfaces **Owner:**

  const t2 = results.find((r) => r.taskId === 't2');
  assert.deepEqual(t2.labels, []); // no risk → no risk label
});

test('dispatchPlan preview: taskIds restricts to the chosen subset', async () => {
  seedPlan();
  const res = await dispatchPlan(U, { planId: 'plan1', target: 'preview', taskIds: ['t2'] });
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].taskId, 't2');
});

test('dispatchPlan: rejects an unknown target', async () => {
  seedPlan();
  await assert.rejects(
    () => dispatchPlan(U, { planId: 'plan1', target: 'mars' }),
    /Unknown dispatch target/,
  );
});

test('dispatchPlan: rejects a missing plan', async () => {
  reset();
  await assert.rejects(
    () => dispatchPlan(U, { planId: 'nope', target: 'preview' }),
    /not found/,
  );
});
