// Regression tests for two KB correctness fixes:
//  1. updateTask must be able to CLEAR owner/due/files/riskReason (explicit
//     null/[]), not just change them — the old COALESCE kept the old value.
//  2. An empty-query search(kind:'outcome') with a projectId filter must return
//     none (outcomes aren't project-tagged), matching the FTS path rather than
//     leaking every project's outcomes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_kb-task-update-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

let U;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  U = users.registerUser(db.getDb(), {
    email: `kbtask-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: 'kbtask',
  }).id;
}

function seedPlan() {
  reset();
  return db.savePlan(U, {
    id: 'plan1',
    title: 'Plan',
    tasks: [{ id: 't1', title: 'Build API', owner: 'Alice' }],
  });
}

// ── updateTask: clearing fields ──────────────────────────────────────

test('updateTask: owner can be cleared with explicit null', () => {
  seedPlan();
  assert.equal(db.getTaskById(U, 't1').owner, 'Alice');
  db.updateTask(U, 't1', { owner: null });
  assert.equal(db.getTaskById(U, 't1').owner, null, 'owner should be cleared');
});

test('updateTask: absent owner key leaves the value unchanged', () => {
  seedPlan();
  db.updateTask(U, 't1', { status: 'done' });
  assert.equal(db.getTaskById(U, 't1').owner, 'Alice', 'owner must survive an unrelated patch');
});

test('updateTask: due can be set then cleared', () => {
  seedPlan();
  db.updateTask(U, 't1', { due: '2026-06-01' });
  assert.equal(db.getTaskById(U, 't1').due, '2026-06-01');
  db.updateTask(U, 't1', { due: null });
  assert.equal(db.getTaskById(U, 't1').due, null, 'due should be cleared');
});

test('updateTask: files can be set then cleared to empty', () => {
  seedPlan();
  db.updateTask(U, 't1', { files: ['a.ts', 'b.ts'] });
  assert.deepEqual(db.getTaskById(U, 't1').files, ['a.ts', 'b.ts']);
  db.updateTask(U, 't1', { files: [] });
  assert.deepEqual(db.getTaskById(U, 't1').files, [], 'files should be cleared to empty');
});

// ── empty-query outcome search: projectId scoping ────────────────────

test('search(kind:outcome): empty query returns the outcome when unscoped', () => {
  seedPlan();
  db.recordOutcome(U, { taskId: 't1', provider: 'github', ref: '#1', state: 'open' });
  const res = db.search(U, { q: '', kind: 'outcome' });
  assert.ok(res.length >= 1, 'unscoped outcome search should return the outcome');
  assert.ok(res.some((r) => r.kind === 'outcome'));
});

test('search(kind:outcome): empty query with a projectId returns none (no cross-project leak)', () => {
  seedPlan();
  db.recordOutcome(U, { taskId: 't1', provider: 'github', ref: '#1', state: 'open' });
  const res = db.search(U, { q: '', kind: 'outcome', projectId: 'proj-x' });
  assert.equal(res.length, 0, 'project-scoped outcome search must not leak untagged outcomes');
});
