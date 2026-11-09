// B5 (Software Factory Phase B, Task 9): the command store's desktop lease. A claimed command is single-claimer: the
// token returned once at claim is required to renew, report progress and finish, and an expired lease becomes
// `interrupted` with exactly one terminal event. Fake commands only; no engine, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(HERE, '_bus-desktop-lease-test.db');
process.env.LLMIDE_DB_PATH = DB;
for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });

const db = await import('../kb/db.mjs');
const store = await import('../kb/bus-store.mjs');
const q = await import('../kb/job-queue.mjs');
const users = await import('../server/users.mjs');

const A = users.registerUser(db.getDb(), { email: 'b5-lease@example.test', password: 'CorrectHorseBattery', displayName: 'a' }).id;
const B = users.registerUser(db.getDb(), { email: 'b5-lease-b@example.test', password: 'CorrectHorseBattery', displayName: 'b' }).id;
let seq = 0;

/** An approved desktop-runner command, the way the executor approves an `issues.implement`. */
function approved(userId = A, kind = 'issues.implement', args = { projectId: 'p1', issueIds: ['i1'], ship: false }) {
  const out = store.createCommand(userId, {
    kind, tier: 'T2', idem: `idem-${++seq}`, args, originClient: 'native-phone', needsApproval: true,
    approvalReason: 'tier', lane: `write:${args.projectId}`, ttlMs: 60_000, jobPayload: { args },
  });
  const cmd = store.approveCommand(userId, out.command.id, { approvedBy: 'desktop-ui', lane: `write:${args.projectId}`, jobPayload: { args }, runner: 'desktop' });
  return cmd;
}

const reset = () => {
  db.getDb().prepare('DELETE FROM job_events').run();
  db.getDb().prepare('DELETE FROM jobs').run();
  db.getDb().prepare('DELETE FROM bus_commands').run();
};

after(() => {
  db.closeDb();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(DB + s, { force: true });
});

test('claim takes the approved job once and returns the one token', () => {
  reset();
  const cmd = approved();
  assert.equal(cmd.state, 'queued');
  const out = store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  assert.equal(out.command.state, 'running');
  assert.equal(typeof out.token, 'string');
  assert.ok(out.token.length >= 32);
  assert.equal(out.command.claimedBy, 'desktop-ui');
  assert.ok(out.command.leaseExpiresAt);
  assert.equal(q.getJob(A, cmd.id).state, 'running');
  assert.equal(store.getCommand(A, cmd.id).state, 'running');
});

test('a second claim while the lease is live is LEASE_HELD; another user sees NOT_FOUND', () => {
  reset();
  const cmd = approved();
  store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  assert.throws(() => store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 }), (e) => e.code === 'LEASE_HELD');
  assert.throws(() => store.claimDesktopCommand(B, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 }), (e) => e.code === 'NOT_FOUND');
});

test('an expired lease can be reclaimed with a new token (single-claimer handover)', () => {
  reset();
  const cmd = approved();
  const first = store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 1_000, now: Date.now() - 10_000 });
  const second = store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  assert.notEqual(second.token, first.token);
  assert.equal(store.getCommand(A, cmd.id).state, 'running');
  assert.throws(() => store.renewDesktopLease(A, cmd.id, { token: first.token, leaseMs: 90_000 }), (e) => e.code === 'LEASE_LOST', 'the old token is dead');
  assert.ok(store.renewDesktopLease(A, cmd.id, { token: second.token, leaseMs: 90_000 }));
});

test('renew extends the lease only for the current token', () => {
  reset();
  const cmd = approved();
  const { token } = store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  const before = store.getCommand(A, cmd.id).leaseExpiresAt;
  const later = Date.now() + 30_000;
  assert.ok(store.renewDesktopLease(A, cmd.id, { token, leaseMs: 90_000, now: later }));
  assert.ok(Date.parse(store.getCommand(A, cmd.id).leaseExpiresAt) > Date.parse(before));
  assert.throws(() => store.renewDesktopLease(A, cmd.id, { token: 'nope', leaseMs: 90_000 }), (e) => e.code === 'LEASE_LOST');
});

test('finish writes exactly one terminal event and a replay is idempotent', () => {
  reset();
  const cmd = approved();
  const { token } = store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  const done = store.finishClaimedCommand(A, cmd.id, { token, state: 'succeeded', result: { readyToShip: true, shipped: false } });
  assert.equal(done.state, 'succeeded');
  assert.deepEqual(q.getJob(A, cmd.id).result, { readyToShip: true, shipped: false });
  const events = store.listEvents(A, cmd.id);
  assert.equal(events.filter((e) => e.terminal).length, 1);
  const again = store.finishClaimedCommand(A, cmd.id, { token, state: 'succeeded', result: { readyToShip: true, shipped: false } });
  assert.equal(again.state, 'succeeded');
  assert.equal(store.listEvents(A, cmd.id).filter((e) => e.terminal).length, 1, 'no second terminal event');
  assert.throws(() => store.finishClaimedCommand(A, cmd.id, { token, state: 'failed', errorCode: 'engine_failed' }), (e) => e.code === 'LEASE_LOST', 'a different terminal state is refused');
});

test('finish without the current token is LEASE_LOST and changes nothing', () => {
  reset();
  const cmd = approved();
  const { token } = store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  assert.throws(() => store.finishClaimedCommand(A, cmd.id, { token: `${token}x`, state: 'succeeded' }), (e) => e.code === 'LEASE_LOST');
  assert.equal(q.getJob(A, cmd.id).state, 'running');
  assert.equal(store.listEvents(A, cmd.id).filter((e) => e.terminal).length, 0);
});

test('an expired lease becomes interrupted with one terminal event; a second sweep is a no-op', () => {
  reset();
  const cmd = approved();
  store.claimDesktopCommand(A, cmd.id, { claimedBy: 'desktop-ui', leaseMs: 1_000, now: Date.now() - 10_000 });
  const expired = store.expireDesktopLeasesSystem();
  assert.deepEqual(expired, [{ id: cmd.id, userId: A }]);
  const job = q.getJob(A, cmd.id);
  assert.equal(job.state, 'interrupted');
  assert.equal(job.error, 'lease_expired');
  const term = store.terminalEvent(A, cmd.id);
  assert.equal(term.type, 'error');
  assert.equal(term.payload.code, 'interrupted');
  assert.deepEqual(store.expireDesktopLeasesSystem(), []);
  assert.equal(store.listEvents(A, cmd.id).filter((e) => e.terminal).length, 1);
});

test('listClaimableCommands lists this user\'s queued desktop rows for the asked kinds, with args and no token', () => {
  reset();
  const first = approved(A, 'issues.implement', { projectId: 'p1', issueIds: ['i1'], ship: false });
  const second = approved(A, 'issues.implement', { projectId: 'p2', issueIds: ['i2', 'i3'], ship: true });
  approved(B, 'issues.implement', { projectId: 'p3', issueIds: ['i9'], ship: false });
  approved(A, 'review', { engine: { provider: 'anthropic' } });
  const rows = store.listClaimableCommands(A, ['issues.implement']);
  assert.deepEqual(rows.map((r) => r.id), [first.id, second.id]);
  assert.deepEqual(rows[1].args, { projectId: 'p2', issueIds: ['i2', 'i3'], ship: true });
  assert.equal('token' in rows[0], false);
  assert.equal('claimToken' in rows[0], false);
  const { token } = store.claimDesktopCommand(A, first.id, { claimedBy: 'desktop-ui', leaseMs: 90_000 });
  assert.equal(typeof token, 'string');
  assert.deepEqual(store.listClaimableCommands(A, ['issues.implement']).map((r) => r.id), [second.id], 'a claimed row is not claimable');
  assert.deepEqual(store.listClaimableCommands(A, ['other.kind']), []);
});
