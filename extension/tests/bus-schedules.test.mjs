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
