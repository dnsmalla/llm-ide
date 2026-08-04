// Regression: `symbols` set by code-sync must survive a savePlan→getPlan round
// trip. Before migration 0026, plan_tasks had no `symbols` column; savePlan
// wrote only `files` + `meta`, and getPlan didn't read `symbols` back — so
// /kb/generate-plan and /kb/code-sync (with planId) returned plans with no
// `symbols`, making the SCIP feature non-functional on persisted-plan paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_plan-tasks-symbols-roundtrip.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

const U = users.registerUser(db.getDb(), {
  email: `symbols-rt-${Date.now()}@example.test`, password: 'CorrectHorseBattery', displayName: 's',
}).id;

const SYMBOLS = [
  { symbol_id: 's X', title: 'X', kind: 'function', source_file: 'x.ts', line: 1 },
  { symbol_id: 's Y', title: 'Y', kind: 'classType', source_file: 'y.ts', line: 42 },
];

test('savePlan→getPlan round-trips the symbols field on plan_tasks', () => {
  const saved = db.savePlan(U, {
    id: 'plan-symbols-rt',
    title: 'Plan with symbols',
    tasks: [{
      id: 't1', title: 'Fix the Button component',
      files: [{ ref: '/repo/b.ts', title: 'b.ts' }],
      symbols: SYMBOLS,
    }],
  });
  assert.ok(Array.isArray(saved.tasks), 'savePlan returns a plan with tasks');

  const got = db.getPlan(U, 'plan-symbols-rt');
  assert.ok(got, 'getPlan returns the plan');
  assert.equal(got.tasks.length, 1);
  const t = got.tasks[0];
  assert.ok(Array.isArray(t.symbols), 'symbols is an array after round-trip');
  assert.deepEqual(t.symbols, SYMBOLS, 'symbols survived savePlan→getPlan unchanged');
  // files still round-trips too (unchanged behavior)
  assert.ok(Array.isArray(t.files) && t.files.length === 1);
});

test('symbols defaults to [] when omitted (column has NOT NULL DEFAULT)', () => {
  db.savePlan(U, {
    id: 'plan-no-symbols',
    title: 'Plan without symbols',
    tasks: [{ id: 't2', title: 'Plain task' }],
  });
  const got = db.getPlan(U, 'plan-no-symbols');
  assert.deepEqual(got.tasks[0].symbols, [], 'missing symbols defaults to []');
});

test('cleanup', () => {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
});
