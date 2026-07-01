// Per-user issue scheduling overlay (gantt parity for GitHub). Pins the
// store contract: upsert/list/delete, field validation, null-clears, and
// tenancy isolation (no cross-user reads/writes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY  = 'b'.repeat(48);
process.env.NODE_ENV = 'test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_issue-schedule-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;

const db = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');

let U, U2;

function reset() {
  db.closeDb();
  for (const f of [tmpDb, `${tmpDb}-shm`, `${tmpDb}-wal`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  db.getDb();
  const mk = (tag) => users.registerUser(db.getDb(), {
    email: `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'CorrectHorseBattery',
    displayName: tag,
  }).id;
  U = mk('sched');
  U2 = mk('other');
}

const REPO = 'octo/repo';

test('upsert then list returns the stored schedule', () => {
  reset();
  const saved = db.upsertIssueSchedule(U, {
    provider: 'github', repo: REPO, issueNumber: 7,
    startDate: '2026-07-01', dueDate: '2026-07-10', estimateDays: 3.5, dependsOn: [4, 5],
  });
  assert.equal(saved.issueNumber, 7);
  assert.equal(saved.startDate, '2026-07-01');
  assert.equal(saved.dueDate, '2026-07-10');
  assert.equal(saved.estimateDays, 3.5);
  assert.deepEqual(saved.dependsOn, [4, 5]);

  const list = db.listIssueSchedules(U, { provider: 'github', repo: REPO });
  assert.equal(list.length, 1);
  assert.equal(list[0].issueNumber, 7);
});

test('upsert is idempotent on the key and replaces fields (null clears)', () => {
  reset();
  db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 7, dueDate: '2026-07-10', estimateDays: 2 });
  const updated = db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 7, dueDate: null, startDate: '2026-07-02' });
  assert.equal(updated.dueDate, null, 'null clears the previous due date');
  assert.equal(updated.estimateDays, null, 'omitted field is replaced, not merged');
  assert.equal(updated.startDate, '2026-07-02');
  const list = db.listIssueSchedules(U, { provider: 'github', repo: REPO });
  assert.equal(list.length, 1, 'still one row for the key');
});

test('dedupes dependsOn and rejects bad values', () => {
  reset();
  const s = db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 1, dependsOn: [3, 3, 9] });
  assert.deepEqual(s.dependsOn, [3, 9]);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 1, dependsOn: ['x'] }), /dependsOn/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 1, dependsOn: [0] }), /positive integer/);
});

test('rejects malformed dates, negative estimates, and bad keys', () => {
  reset();
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 1, dueDate: '07/10/2026' }), /YYYY-MM-DD/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 1, estimateDays: -2 }), /non-negative/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: 'no-slash', issueNumber: 1 }), /owner\/name/);
  // path-shaping / junk segments rejected
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: '../../etc/passwd', issueNumber: 1 }), /owner\/name/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: 'a/..', issueNumber: 1 }), /owner\/name/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: 'owner /name', issueNumber: 1 }), /owner\/name/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'bitbucket', repo: REPO, issueNumber: 1 }), /provider/);
  assert.throws(() => db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 0 }), /positive integer/);
});

test('delete removes the row', () => {
  reset();
  db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 7, dueDate: '2026-07-10' });
  assert.equal(db.deleteIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 7 }), true);
  assert.equal(db.deleteIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 7 }), false, 'second delete is a no-op');
  assert.equal(db.listIssueSchedules(U, { provider: 'github', repo: REPO }).length, 0);
});

test('tenancy: one user never sees or deletes another user\'s overlay', () => {
  reset();
  db.upsertIssueSchedule(U,  { provider: 'github', repo: REPO, issueNumber: 7, dueDate: '2026-07-10' });
  db.upsertIssueSchedule(U2, { provider: 'github', repo: REPO, issueNumber: 7, dueDate: '2026-08-20' });
  // Same key, different users → two independent rows.
  assert.equal(db.listIssueSchedules(U,  { provider: 'github', repo: REPO })[0].dueDate, '2026-07-10');
  assert.equal(db.listIssueSchedules(U2, { provider: 'github', repo: REPO })[0].dueDate, '2026-08-20');
  // U2 deleting its row leaves U's row intact.
  db.deleteIssueSchedule(U2, { provider: 'github', repo: REPO, issueNumber: 7 });
  assert.equal(db.listIssueSchedules(U, { provider: 'github', repo: REPO }).length, 1);
});

test('deleteUserCascade removes the user\'s overlay rows', () => {
  reset();
  db.upsertIssueSchedule(U, { provider: 'github', repo: REPO, issueNumber: 7, dueDate: '2026-07-10' });
  const counts = db.deleteUserCascade(U);
  assert.ok(counts.issue_schedule >= 1, 'cascade reports the deleted overlay rows');
});
