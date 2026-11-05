// Desktop scheduler records and standing approvals for the command bus (plan
// docs/superpowers/plans/2026-11-05-desktop-job-scheduler-approvals.md, spec docs/spec/command-bus.md section 9).
// No network, no engine: sources.update runs on a fake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
process.env.LLMIDE_LOG_FILE = 'none';
delete process.env.LLMIDE_BUS;
process.env.LLMIDE_BUS_TRUST_CLIENT_HEADER = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(HERE, '_bus-schedules-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });

const kb = await import('../kb/db.mjs');
const users = await import('../server/users.mjs');
const sched = await import('../kb/bus-schedules.mjs');
const bstore = await import('../kb/bus-store.mjs');
const policy = await import('../routes/bus/schedules.mjs');
const { createBus, approvalNonce } = await import('../routes/bus/executor.mjs');
const { handleBusRoute } = await import('../routes/bus/bus-routes.mjs');

const db = kb.getDb();
let n = 0;
const mkUser = () => users.registerUser(db, { email: `bs-${Date.now()}-${++n}@example.com`, password: 'CorrectHorseBattery', displayName: 'b' }).id;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout waiting'); await sleep(15); } };
const ACCT = 'aaaaaaaaaaaa';
const ARGS = { sourceIds: [`gcal:${ACCT}`] };

const ran = [];
const fakeSources = async ({ userId, args }) => { ran.push({ userId, args }); return { synced: 1, refused: 0, skipped: 0, results: [], text: 'Synced 1 of 1 sources.' }; };
const bus = createBus({ graceMs: 50, sweepMs: 60_000, deps: { runSourcesUpdate: fakeSources } });
bus.start();

const server = http.createServer(async (req, res) => { req.user = { id: req.headers['x-test-user'] }; await handleBusRoute(req, res, { bus }); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
function call(method, p, body, { user, client = 'desktop-ui' } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false,
      headers: { 'x-test-user': user, ...(client ? { 'x-llmide-client': client } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => { let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(t); } catch { /* not json */ } resolve({ status: res.statusCode, body: json }); }); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const nonceOf = (u, id) => approvalNonce(u, id, db.prepare('SELECT args_hash FROM bus_commands WHERE user_id = ? AND id = ?').get(u, id).args_hash);

after(async () => {
  await bus.stop();
  await new Promise((r) => server.close(r));
  kb.closeDb();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });
});

test('store: create, list and delete are per user; standing is computed from standing_until', () => {
  const u = mkUser(); const other = mkUser();
  const now = Date.now();
  const a = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30, now });
  const b = sched.createSchedule(u, { kind: 'sources.update', args: {}, intervalMs: 3_600_000, standingDays: null, now });
  assert.equal(a.standing, true);
  assert.equal(Date.parse(a.standingUntil), now + 30 * 86_400_000);
  assert.equal(b.standing, false); assert.equal(b.standingUntil, null);
  assert.deepEqual(a.args, ARGS);
  assert.equal(a.argsHash, bstore.argsHashOf('sources.update', ARGS));
  assert.deepEqual(sched.listSchedules(u).map((s) => s.id), [a.id, b.id]);
  assert.deepEqual(sched.listSchedules(other), []);
  assert.equal(sched.getSchedule(other, a.id), null, 'another user reads nothing');
  assert.equal(sched.deleteSchedule(other, a.id), false, 'another user deletes nothing');
  assert.equal(sched.getSchedule(u, a.id, now + 31 * 86_400_000).standing, false, 'expired');
  assert.equal(sched.deleteSchedule(u, a.id), true);
  assert.equal(sched.getSchedule(u, a.id), null);
});

test('store: at most SCHEDULE_LIMITS.maxPerUser schedules; interval bounds are a CHECK', () => {
  const u = mkUser();
  for (let i = 0; i < sched.SCHEDULE_LIMITS.maxPerUser; i++) sched.createSchedule(u, { kind: 'sources.update', args: {}, intervalMs: 3_600_000, standingDays: null });
  assert.throws(() => sched.createSchedule(u, { kind: 'sources.update', args: {}, intervalMs: 3_600_000, standingDays: null }), { code: 'QUOTA_EXCEEDED' });
  const v = mkUser();
  assert.throws(() => sched.createSchedule(v, { kind: 'sources.update', args: {}, intervalMs: 60_000, standingDays: null }), /CHECK/);
});

test('policy: only listed T1 kinds; standing needs explicit sourceIds; bounds', () => {
  const ok = policy.parseScheduleBody({ kind: 'sources.update', args: ARGS, intervalHours: 6, standing: true });
  assert.deepEqual(ok, { ok: true, value: { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 } });
  assert.equal(policy.parseScheduleBody({ kind: 'sources.update', args: {}, intervalHours: 6 }).ok, true, 'ask-each-run may cover every source');
  for (const [body, why] of [
    [{ kind: 'issues.implement', args: { projectId: 'p1', issueIds: ['1'] }, intervalHours: 6 }, 'T2 never'],
    [{ kind: 'review', args: { focus: 'code', projectId: 'p1' }, intervalHours: 6 }, 'T0 not listed'],
    [{ kind: 'loop.run', args: { projectId: 'p1', loopId: 'l1' }, intervalHours: 6 }, 'unavailable T1 not listed'],
    [{ kind: 'sources.update', args: {}, intervalHours: 6, standing: true }, 'standing without sourceIds'],
    [{ kind: 'sources.update', args: { sourceIds: [] }, intervalHours: 6, standing: true }, 'standing with empty sourceIds'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 0 }, 'interval < 1'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 169 }, 'interval > 168'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 1.5 }, 'non-integer interval'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 6, standing: true, standingDays: 91 }, 'days > 90'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 6, standingDays: 5 }, 'days without standing'],
    [{ kind: 'sources.update', args: { sourceIds: ['has space'] }, intervalHours: 6 }, 'args schema'],
    [{ kind: 'sources.update', args: ARGS, intervalHours: 6, extra: 1 }, 'unknown field'],
    [null, 'not an object'],
  ]) assert.equal(policy.parseScheduleBody(body).ok, false, why);
});

test('policy: standingRefusal checks expiry, origin, tier, scope, idem and rate', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const hash = bstore.argsHashOf('sources.update', ARGS);
  const schedule = { id: 'sched-0001', kind: 'sources.update', argsHash: hash, intervalMs: 6 * 3_600_000, standing: true, standingUntil: '2026-12-01T00:00:00.000Z', lastRunAt: null };
  const cmd = { kind: 'sources.update', tier: 'T1', originClient: 'desktop-ui', idem: 'sched:sched-0001:7' };
  const r = (s, c, h = hash) => policy.standingRefusal({ schedule: s, cmd: c, argsHash: h, now });
  assert.equal(r(schedule, cmd), null);
  assert.equal(r(null, cmd), 'no_schedule');
  assert.equal(r({ ...schedule, standing: false, standingUntil: null }, cmd), 'standing_expired');
  assert.equal(r({ ...schedule, standingUntil: '2026-11-05T11:59:59.000Z' }, cmd), 'standing_expired');
  assert.equal(r(schedule, { ...cmd, originClient: 'ios-native' }), 'origin');
  assert.equal(r(schedule, { ...cmd, tier: 'T2' }), 'tier');
  assert.equal(r(schedule, cmd, 'f'.repeat(64)), 'scope');
  assert.equal(r(schedule, { ...cmd, idem: 'phone-1' }), 'not_scheduled');
  assert.equal(r(schedule, { ...cmd, idem: 'sched:sched-0002:7' }), 'not_scheduled');
  assert.equal(r({ ...schedule, lastRunAt: '2026-11-05T10:00:00.000Z' }, cmd), 'too_soon');
  assert.equal(r({ ...schedule, lastRunAt: '2026-11-05T08:00:00.000Z' }, cmd), null);
});

/** Enqueue as the desktop for `s` (slot `slot`) and return the command id. */
const enqueueFor = (u, s, slot = 1, client = 'desktop-ui', args = s.args) =>
  bus.receive(u, { v: 1, kind: s.kind, idem: `sched:${s.id}:${slot}`, args }, { client }).command.id;

test('executor: a standing approval approves the desktop run with the nonce; the run is recorded on the schedule', async () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const id = enqueueFor(u, s);
  assert.equal(bstore.getCommand(u, id).state, 'awaiting_approval', 'T1 still waits at receipt');
  bus.approve(u, id, { client: 'desktop-ui', nonce: nonceOf(u, id), scheduleId: s.id });
  await until(() => bstore.getCommand(u, id).state === 'succeeded');
  const cmd = bstore.getCommand(u, id);
  assert.equal(cmd.approvedBy, 'desktop-ui', 'approved_by is still recorded');
  assert.equal(cmd.scheduleId, s.id);
  assert.ok(sched.getSchedule(u, s.id).lastRunAt);
  assert.deepEqual(ran.at(-1), { userId: u, args: ARGS });
});

test('executor: the nonce is still required, and a standing approval never covers a phone command, other args, an expired or a too-soon run', () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const reason = (fn) => { try { fn(); } catch (e) { return e.code === 'STANDING_APPROVAL_INVALID' ? e.details.reason : e.code; } return 'approved'; };
  const a = enqueueFor(u, s, 1);
  assert.equal(reason(() => bus.approve(u, a, { client: 'desktop-ui', nonce: '0'.repeat(64), scheduleId: s.id })), 'APPROVAL_NONCE_INVALID');
  assert.equal(reason(() => bus.approve(u, a, { client: 'ios-native', nonce: nonceOf(u, a), scheduleId: s.id })), 'TIER_DENIED');
  const phone = enqueueFor(u, s, 2, 'ios-native');
  assert.equal(reason(() => bus.approve(u, phone, { client: 'desktop-ui', nonce: nonceOf(u, phone), scheduleId: s.id })), 'origin');
  const wider = enqueueFor(u, s, 3, 'desktop-ui', { sourceIds: [`gcal:${ACCT}`, 'ical:bbbbbbbbbbbb'] });
  assert.equal(reason(() => bus.approve(u, wider, { client: 'desktop-ui', nonce: nonceOf(u, wider), scheduleId: s.id })), 'scope');
  assert.equal(reason(() => bus.approve(u, a, { client: 'desktop-ui', nonce: nonceOf(u, a), scheduleId: 'no-such-schedule' })), 'no_schedule');
  assert.equal(reason(() => bus.approve(u, a, { client: 'desktop-ui', nonce: nonceOf(u, a), scheduleId: s.id })), 'approved');
  const b = enqueueFor(u, s, 4);
  assert.equal(reason(() => bus.approve(u, b, { client: 'desktop-ui', nonce: nonceOf(u, b), scheduleId: s.id })), 'too_soon');
  db.prepare('UPDATE bus_schedules SET standing_until = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), s.id);
  db.prepare('UPDATE bus_schedules SET last_run_at = NULL WHERE id = ?').run(s.id);
  assert.equal(reason(() => bus.approve(u, b, { client: 'desktop-ui', nonce: nonceOf(u, b), scheduleId: s.id })), 'standing_expired');
  assert.equal(bstore.getCommand(u, b).state, 'awaiting_approval', 'a refused standing approval leaves the command for a click');
  assert.equal(reason(() => bus.approve(u, b, { client: 'desktop-ui', nonce: nonceOf(u, b) })), 'approved', 'a click still approves it');
});

test('executor: revoking (deleting) the schedule after approval stops the queued run at execution', async () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const id = enqueueFor(u, s);
  const before = ran.length;
  bus.approve(u, id, { client: 'desktop-ui', nonce: nonceOf(u, id), scheduleId: s.id });
  sched.deleteSchedule(u, s.id);
  await until(() => ['succeeded', 'failed', 'interrupted'].includes(bstore.getCommand(u, id).state));
  const cmd = bstore.getCommand(u, id);
  assert.equal(cmd.state, 'failed'); assert.equal(cmd.error, 'switch_off');
  assert.equal(ran.length, before, 'the sync never ran');
});

test('executor: the T1 execution check from 4e9ad5e1 still holds for a standing run', async () => {
  const u = mkUser();
  const s = sched.createSchedule(u, { kind: 'sources.update', args: ARGS, intervalMs: 6 * 3_600_000, standingDays: 30 });
  const id = enqueueFor(u, s);
  const before = ran.length;
  bus.approve(u, id, { client: 'desktop-ui', nonce: nonceOf(u, id), scheduleId: s.id });
  db.prepare('UPDATE bus_commands SET approved_by = NULL WHERE user_id = ? AND id = ?').run(u, id);
  await until(() => ['succeeded', 'failed', 'interrupted'].includes(bstore.getCommand(u, id).state));
  assert.equal(bstore.getCommand(u, id).error, 'tier_denied');
  assert.equal(ran.length, before);
});
