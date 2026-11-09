// B5 (Software Factory Phase B, Task 9): desktop-claimed bus commands. The job queue side: a desktop-runner row is
// never claimed by the core runner, boot/sweep leave it alone (the lease sweep owns it), and the claimable list is
// per kind. Fake rows only; no provider, no engine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, '_job-queue-desktop-test.db');
process.env.LLMIDE_DB_PATH = DB;
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });

const db = await import('../kb/db.mjs');
const q = await import('../kb/job-queue.mjs');
const users = await import('../server/users.mjs');

const mk = (e) => users.registerUser(db.getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
const A = mk('b5-queue@example.test');
const reset = () => db.getDb().prepare('DELETE FROM jobs').run();
const old = () => new Date(Date.now() - 120_000).toISOString();

after(() => {
  db.closeDb();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

test("the core runner never claims a desktop-runner job, even when it is older", () => {
  reset();
  const desktop = q.enqueueJob(A, { kind: 'issues.implement', lane: 'write:p1', payload: { args: {} }, runner: 'desktop' });
  assert.equal(q.getJob(A, desktop.id).runner, 'desktop');
  const core = q.enqueueJob(A, { kind: 'review', lane: 'read:review:p1', payload: { args: {} } });
  assert.equal(q.getJob(A, core.id).runner, 'core', 'the default runner is the core');
  const claimed = q.claimNextJobSystem();
  assert.equal(claimed.id, core.id, 'the older desktop row is skipped');
  assert.equal(q.claimNextJobSystem(), null, 'the desktop row is still not claimable');
  assert.equal(q.getJob(A, desktop.id).state, 'queued');
});

test("the boot sweep interrupts a running desktop job as a lost lease and never requeues it", () => {
  reset();
  const j = q.enqueueJob(A, { kind: 'issues.implement', lane: 'write:p1', payload: { args: {} }, runner: 'desktop' });
  q.claimNextJobSystem(); // null: desktop rows are skipped, so force the running state the way the claim route does
  db.getDb().prepare("UPDATE jobs SET state='running', started_at=? WHERE id=?").run(new Date().toISOString(), j.id);
  // A resumable kind still is not requeued when it belongs to the desktop: the lease is gone.
  const swept = q.sweepInterruptedSystem(['issues.implement']);
  assert.deepEqual(swept.interrupted, [j.id]);
  assert.deepEqual(swept.requeued, []);
  const row = q.getJob(A, j.id);
  assert.equal(row.state, 'interrupted');
  assert.equal(row.error, 'lease_lost');
});

test("the orphan reap leaves a running desktop job to the lease sweep", () => {
  reset();
  const desktop = q.enqueueJob(A, { kind: 'issues.implement', lane: 'write:p1', payload: { args: {} }, runner: 'desktop' });
  const core = q.enqueueJob(A, { kind: 'review', lane: 'read:review:p2', payload: { args: {} } });
  db.getDb().prepare("UPDATE jobs SET state='running', started_at=? WHERE id IN (?,?)").run(old(), desktop.id, core.id);
  const reaped = q.reapOrphanedRunningSystem([], { staleMs: 30_000 });
  assert.deepEqual(reaped.map((r) => r.id), [core.id], 'only the core row this runner does not hold is reaped');
  assert.equal(q.getJob(A, desktop.id).state, 'running', 'the desktop row is still held by its lease');
});

test("listClaimableJobsSystem lists queued desktop rows of the asked kinds, oldest first, bounded", () => {
  reset();
  const a = q.enqueueJob(A, { kind: 'issues.implement', lane: 'l1', payload: { args: {} }, runner: 'desktop' });
  const b = q.enqueueJob(A, { kind: 'issues.implement', lane: 'l2', payload: { args: {} }, runner: 'desktop' });
  q.enqueueJob(A, { kind: 'review', lane: 'l3', payload: { args: {} } });
  q.enqueueJob(A, { kind: 'issues.implement', lane: 'l4', payload: { args: {} } }); // core runner row of the same kind
  db.getDb().prepare("UPDATE jobs SET created_at='2026-11-09T10:00:00.000Z' WHERE id=?").run(a.id);
  db.getDb().prepare("UPDATE jobs SET created_at='2026-11-09T10:01:00.000Z' WHERE id=?").run(b.id);
  assert.deepEqual(q.listClaimableJobsSystem(['issues.implement']).map((r) => r.id), [a.id, b.id]);
  assert.deepEqual(q.listClaimableJobsSystem(['issues.implement'], { limit: 1 }).map((r) => r.id), [a.id]);
  assert.deepEqual(q.listClaimableJobsSystem(['other.kind']), []);
  db.getDb().prepare("UPDATE jobs SET state='running' WHERE id=?").run(a.id);
  assert.deepEqual(q.listClaimableJobsSystem(['issues.implement']).map((r) => r.id), [b.id], 'a running row is not claimable');
});
