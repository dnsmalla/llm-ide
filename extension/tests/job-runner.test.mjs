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
