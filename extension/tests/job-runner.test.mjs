// Core job runner: persisted queue, lane lock, cancel, quit, process-group kill,
// interrupted marking, tenancy, bounded concurrency. Fake handlers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_job-runner-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const main = await import('../kb/db.mjs');
const q = await import('../kb/job-queue.mjs');
const { createJobRunner } = await import('../kb/job-runner.mjs');
const users = await import('../server/users.mjs');
const mk = (e) => users.registerUser(main.getDb(), { email: e, password: 'CorrectHorseBattery', displayName: e }).id;
const A = mk('job-a@example.test');
const B = mk('job-b@example.test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await sleep(10); } };
const reset = () => main.getDb().prepare('DELETE FROM jobs').run();

test.after(() => { main.closeDb(); for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true }); });

test('runs a job to success and stores the result', async () => {
  reset();
  const r = createJobRunner({ handlers: { echo: async ({ job }) => ({ got: job.payload.x }) } });
  const j = q.enqueueJob(A, { kind: 'echo', lane: 'l', payload: { x: 7 } });
  r.start();
  await until(() => q.getJob(A, j.id).state === 'succeeded');
  assert.deepEqual(q.getJob(A, j.id).result, { got: 7 });
  await r.stop();
});

test('handler error -> failed with message', async () => {
  reset();
  const r = createJobRunner({ handlers: { bad: async () => { throw new Error('boom'); } } });
  const j = q.enqueueJob(A, { kind: 'bad', lane: 'l' });
  r.start();
  await until(() => q.getJob(A, j.id).state === 'failed');
  assert.equal(q.getJob(A, j.id).error, 'boom');
  await r.stop();
});

test('lane lock: same user+lane serial, other lane/user parallel', async () => {
  reset();
  let live = 0; let maxLive = 0;
  const slow = async () => { live++; maxLive = Math.max(maxLive, live); await sleep(80); live--; };
  const r = createJobRunner({ handlers: { slow }, maxConcurrent: 5 });
  q.enqueueJob(A, { kind: 'slow', lane: 'x' }); q.enqueueJob(A, { kind: 'slow', lane: 'x' });
  r.start();
  await until(() => q.listJobs(A, { state: 'succeeded' }).length === 2);
  assert.equal(maxLive, 1);
  maxLive = 0;
  q.enqueueJob(A, { kind: 'slow', lane: 'x' }); q.enqueueJob(A, { kind: 'slow', lane: 'y' }); q.enqueueJob(B, { kind: 'slow', lane: 'x' });
  r.pump();
  await until(() => q.listJobs(A, { state: 'succeeded' }).length === 4 && q.listJobs(B, { state: 'succeeded' }).length === 1);
  assert.equal(maxLive, 3);
  await r.stop();
});

test('the DB itself refuses two running jobs on one lane', () => {
  reset();
  const a = q.enqueueJob(A, { kind: 'k', lane: 'z' }); const b = q.enqueueJob(A, { kind: 'k', lane: 'z' });
  const db = main.getDb();
  db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(a.id);
  assert.throws(() => db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(b.id), /UNIQUE/);
});

test('bounded concurrency', async () => {
  reset();
  let live = 0; let maxLive = 0;
  const slow = async () => { live++; maxLive = Math.max(maxLive, live); await sleep(60); live--; };
  const r = createJobRunner({ handlers: { slow }, maxConcurrent: 2 });
  for (let i = 0; i < 5; i++) q.enqueueJob(A, { kind: 'slow', lane: `l${i}` });
  r.start();
  await until(() => q.listJobs(A, { state: 'succeeded' }).length === 5);
  assert.equal(maxLive, 2);
  await r.stop();
});

test('cancel: queued is cancelled at once; running aborts the handler', async () => {
  reset();
  const r = createJobRunner({ handlers: { wait: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))) } });
  const run = q.enqueueJob(A, { kind: 'wait', lane: 'c' });
  const queued = q.enqueueJob(A, { kind: 'wait', lane: 'c' });
  r.start();
  await until(() => q.getJob(A, run.id).state === 'running');
  assert.equal(r.cancel(A, queued.id).was, 'queued');
  assert.equal(q.getJob(A, queued.id).state, 'cancelled');
  assert.equal(r.cancel(A, run.id).was, 'running');
  await until(() => q.getJob(A, run.id).state === 'cancelled');
  assert.equal(r.cancel(A, run.id).ok, false);
  await r.stop();
});

test('tenancy: another user cannot see or cancel a job', async () => {
  reset();
  const j = q.enqueueJob(A, { kind: 'k', lane: 'l' });
  assert.equal(q.getJob(B, j.id), null);
  assert.equal(q.listJobs(B).length, 0);
  assert.equal(q.requestCancel(B, j.id).reason, 'not_found');
  assert.equal(q.getJob(A, j.id).state, 'queued');
});

test('boot sweep: orphaned running -> interrupted; resumable -> requeued and re-run', async () => {
  reset();
  const a = q.enqueueJob(A, { kind: 'plain', lane: 'p' }); const b = q.enqueueJob(A, { kind: 'again', lane: 'q' });
  main.getDb().prepare("UPDATE jobs SET state='running', attempts=1").run();
  let ran = 0;
  const r = createJobRunner({ handlers: { plain: async () => {}, again: { resumable: true, run: async () => { ran++; } } } });
  const swept = r.start();
  assert.deepEqual(swept.interrupted, [a.id]);
  assert.deepEqual(swept.requeued, [b.id]);
  assert.equal(q.getJob(A, a.id).state, 'interrupted');
  await until(() => q.getJob(A, b.id).state === 'succeeded');
  assert.equal(ran, 1);
  assert.equal(q.getJob(A, b.id).attempts, 2);
  await r.stop();
});

test('stop() (server quit) aborts running jobs, journals cancelled/server_quit, leaves queued', async () => {
  reset();
  const r = createJobRunner({ handlers: { wait: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))) } });
  const run = q.enqueueJob(A, { kind: 'wait', lane: 'q' });
  const next = q.enqueueJob(A, { kind: 'wait', lane: 'q' });
  r.start();
  await until(() => q.getJob(A, run.id).state === 'running');
  await r.stop();
  assert.equal(q.getJob(A, run.id).state, 'cancelled');
  assert.equal(q.getJob(A, run.id).error, 'server_quit');
  assert.equal(q.getJob(A, next.id).state, 'queued');
  assert.equal(r.activeCount(), 0);
});

test('process group: cancel kills the child and its grandchild', async () => {
  reset();
  const pidFile = path.join(__dirname, '_job-runner-grandchild.pid');
  fs.rmSync(pidFile, { force: true });
  const r = createJobRunner({ graceMs: 300, handlers: {
    sh: ({ spawn }) => spawn('/bin/sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`]),
  } });
  const j = q.enqueueJob(A, { kind: 'sh', lane: 'g' });
  r.start();
  await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim());
  const gpid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  process.kill(gpid, 0);                       // alive
  r.cancel(A, j.id);
  await until(() => q.getJob(A, j.id).state === 'cancelled');
  await until(() => { try { process.kill(gpid, 0); return false; } catch { return true; } });
  fs.rmSync(pidFile, { force: true });
  await r.stop();
});

// ---- review M4/M5 ----
const { runGrouped, groupAlive, sanitizedEnv } = await import('../core/process-group.mjs');

test('M4: runGrouped gets a sanitized env by default (no server secrets) and uses an explicit env as given', async () => {
  const code = 'process.stdout.write(JSON.stringify({ v: process.env.LLMIDE_VAULT_KEY ?? null, j: process.env.LLMIDE_JWT_SECRET ?? null, f: process.env.FOO ?? null, p: !!process.env.PATH }))';
  const def = await runGrouped(process.execPath, ['-e', code]);
  assert.deepEqual(JSON.parse(def.stdout), { v: null, j: null, f: null, p: true });
  const exp = await runGrouped(process.execPath, ['-e', code], { env: { FOO: '1' } });
  assert.deepEqual(JSON.parse(exp.stdout), { v: null, j: null, f: '1', p: false }, 'explicit env only: process.env is not merged in');
  assert.equal(sanitizedEnv({ PATH: '/x', LLMIDE_VAULT_KEY: 's', AWS_SECRET_ACCESS_KEY: 'k' }).LLMIDE_VAULT_KEY, undefined);
});

test('M4: onExit prunes the pid; survivors of a live group are swept; a dead group is never signalled', async () => {
  const seen = []; const gone = [];
  const r = await runGrouped('sh', ['-c', 'sleep 30 & echo $!'], { onSpawn: (p) => seen.push(p), onExit: (p) => gone.push(p) });
  assert.deepEqual(gone, seen);
  const sleeper = Number(r.stdout.trim());
  await sleep(100);
  assert.throws(() => process.kill(sleeper, 0), /ESRCH/, 'the surviving member of the group was swept');
  assert.equal(groupAlive(seen[0]), false, 'the group is now empty: nothing left to signal');
  assert.equal(groupAlive(0), false);
});

test('M4: the runner tracks only live pids (pruned on exit)', async () => {
  reset();
  let seen = 0;
  const r = createJobRunner({ handlers: { sh: async ({ spawn }) => { await spawn('true', [], { onSpawn: () => { seen += 1; } }); return 'ok'; } } });
  q.enqueueJob(A, { kind: 'sh', lane: 'm4' });
  r.start();
  await until(() => q.listJobs(A, { state: 'succeeded' }).length === 1);
  assert.equal(seen, 1);
  await r.stop();
});

test('M5: a throwing finish never leaves the slot taken', async () => {
  reset();
  const db = main.getDb();
  const r = createJobRunner({ handlers: { ok: async () => 1 }, maxConcurrent: 1 });
  const a = q.enqueueJob(A, { kind: 'ok', lane: 'f1' });
  const b = q.enqueueJob(A, { kind: 'ok', lane: 'f2' });
  // make the first settle blow up: drop the row's table write by a trigger that raises
  db.exec("CREATE TRIGGER fail_finish BEFORE UPDATE OF state ON jobs WHEN NEW.state='succeeded' AND OLD.state='running' AND NEW.id='" + a.id + "' BEGIN SELECT RAISE(ABORT,'boom'); END");
  try {
    r.start();
    await until(() => q.getJob(A, b.id).state === 'succeeded');
    assert.equal(r.activeCount(), 0);
  } finally { db.exec('DROP TRIGGER fail_finish'); await r.stop(); }
});

test('M5: a handler that ignores abort is failed "timeout" and frees its lane', async () => {
  reset();
  const never = () => new Promise(() => {});
  const r = createJobRunner({ handlers: { hang: { run: never, timeoutMs: 60 }, next: async () => 'ran' }, graceMs: 30 });
  const h = q.enqueueJob(A, { kind: 'hang', lane: 'tl' });
  const n = q.enqueueJob(A, { kind: 'next', lane: 'tl' });
  r.start();
  await until(() => q.getJob(A, h.id).state === 'failed');
  assert.equal(q.getJob(A, h.id).error, 'timeout');
  await until(() => q.getJob(A, n.id).state === 'succeeded');
  // a handler that honours abort is also reported as timeout, not cancelled
  const r2 = createJobRunner({ handlers: { polite: { timeoutMs: 40, run: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('x')))) } }, graceMs: 30 });
  const p = q.enqueueJob(A, { kind: 'polite', lane: 'tl2' });
  r2.start();
  await until(() => q.getJob(A, p.id).state === 'failed');
  assert.equal(q.getJob(A, p.id).error, 'timeout');
  await r.stop(); await r2.stop();
});

test('M5: boot sweep keeps cancel_requested (cancelled, not requeued) and caps attempts of a poison resumable job', async () => {
  reset();
  const c = q.enqueueJob(A, { kind: 'again', lane: 's1' });
  const poison = q.enqueueJob(A, { kind: 'again', lane: 's2' });
  const fine = q.enqueueJob(A, { kind: 'again', lane: 's3' });
  const db = main.getDb();
  db.prepare("UPDATE jobs SET state='running', attempts=1 WHERE id IN (?,?)").run(c.id, fine.id);
  db.prepare("UPDATE jobs SET cancel_requested=1 WHERE id=?").run(c.id);
  db.prepare("UPDATE jobs SET state='running', attempts=? WHERE id=?").run(q.MAX_ATTEMPTS, poison.id);
  const swept = q.sweepInterruptedSystem(['again']);
  assert.deepEqual(swept.cancelled, [c.id]);
  assert.deepEqual(swept.failed, [poison.id]);
  assert.deepEqual(swept.requeued, [fine.id]);
  assert.equal(q.getJob(A, c.id).state, 'cancelled');
  assert.equal(q.getJob(A, poison.id).error, 'too_many_attempts');
});

test('M5: per-user queue quota and payload cap; another user is unaffected', () => {
  reset();
  assert.throws(() => q.enqueueJob(A, { kind: 'k', lane: 'p', payload: { big: 'x'.repeat(q.MAX_PAYLOAD_BYTES) } }), (e) => e.code === 'payload_too_large');
  for (let i = 0; i < q.MAX_ACTIVE_JOBS_PER_USER; i++) q.enqueueJob(A, { kind: 'k', lane: `q${i}` });
  assert.throws(() => q.enqueueJob(A, { kind: 'k', lane: 'over' }), (e) => e.code === 'quota_exceeded');
  assert.ok(q.enqueueJob(B, { kind: 'k', lane: 'ok' }));
  reset();
});
