// Agent store lifecycle (Stage 1b): boot step, stale-run sweep, pending-purge
// replay, the rollup tick and the post-listen copy job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-jobs-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const main = await import('../kb/db.mjs');
const agent = await import('../kb/agent-db.mjs');
const store = await import('../kb/agent-store.mjs');
const jobs = await import('../kb/agent-jobs.mjs');
const copy = await import('../kb/agent-history-copy.mjs');
const users = await import('../server/users.mjs');
const { config } = await import('../core/config.mjs');
const { recordActivity } = await import('../kb/activity.mjs');
const { openRun } = await import('../kb/agent-store.mjs');

const U = users.registerUser(main.getDb(), { email: 'jobs-a@example.test', password: 'CorrectHorseBattery', displayName: 'a' }).id;
const agentFiles = [config.agentDbPath, `${config.agentDbPath}-wal`, `${config.agentDbPath}-shm`];
function fresh() {
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const db = agent.getAgentDb();
  assert.ok(db);
  return db;
}
const count = (db, sql, ...a) => db.prepare(sql).get(...a).n;

test.after(() => {
  jobs.stopAgentStoreJobs();
  agent.closeAgentDb();
});

test('openAgentStoreAtBoot opens the store, raises the id floors and reports ok', () => {
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const r = jobs.openAgentStoreAtBoot({});
  assert.equal(r.ok, true);
  assert.equal(agent.agentStoreStatus().state, 'ok');
});

test('a run left open for more than 24 hours is closed as aborted at boot; a fresh one is kept', () => {
  const db = fresh();
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  openRun(U, { runId: 'stale-1', source: 'chat', engine: 'v2' }, { now: old });
  openRun(U, { runId: 'fresh-1', source: 'chat', engine: 'v2' });
  agent.flushAgentQueue();
  assert.equal(store.abortStaleRuns({ db }), 1);
  assert.equal(db.prepare("SELECT status, error_code FROM agent_runs WHERE run_id = 'stale-1'").get().status, 'aborted');
  assert.equal(db.prepare("SELECT status FROM agent_runs WHERE run_id = 'fresh-1'").get().status, 'running');
});

test('pending purge markers are replayed at boot and removed', () => {
  const db = fresh();
  recordActivity({ userId: U, kind: 'meeting_added', title: 'to purge' });
  agent.flushAgentQueue();
  assert.ok(count(db, 'SELECT COUNT(*) AS n FROM activity WHERE user_id = ?', U) >= 1);
  agent.writeMeta(db, `pending_purge:${U}`, new Date().toISOString());
  const r = jobs.openAgentStoreAtBoot({});
  assert.equal(r.ok, true);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM activity WHERE user_id = ?', U), 0);
  assert.equal(agent.readMeta(db, `pending_purge:${U}`), null);
});

test('dailyRollupDue: 03:10 local, once per day', () => {
  const at = (h, m) => { const d = new Date(2026, 9, 28, h, m, 0); return d; };
  assert.equal(jobs.dailyRollupDue(null, at(3, 9)), false, 'not before 03:10');
  assert.equal(jobs.dailyRollupDue(null, at(3, 10)), true, 'due at 03:10');
  assert.equal(jobs.dailyRollupDue(null, at(15, 0)), true, 'due later the same day when it has not run');
  assert.equal(jobs.dailyRollupDue('2026-10-28', at(15, 0)), false, 'not again the same day');
});

test('the tick runs a rollup when the size watchdog requested one, and clears the request', () => {
  const db = fresh();
  agent.writeMeta(db, 'soft_bytes', 1);            // any file is over the soft threshold
  agent.checkStorageSize();
  const r = jobs.agentStoreTick(new Date(), {});
  assert.equal(r.ran, true);
  assert.equal(r.requested, true);
  assert.ok(agent.readMeta(db, 'last_rollup_at'), 'a rollup was recorded');
  assert.equal(agent.takeRollupRequest(), false, 'the request was consumed');
  agent.writeMeta(db, 'soft_bytes', 256 * 1024 * 1024);
});

test('over the soft threshold, three ticks run one rollup, not three', () => {
  const db = fresh();
  agent.writeMeta(db, 'soft_bytes', 1);            // any file is over the soft threshold
  const ran = [0, 1, 2].map(() => jobs.agentStoreTick(new Date(), {}).ran);
  assert.deepEqual(ran, [true, false, false], 'only the transition into soft rolls up');
  agent.writeMeta(db, 'soft_bytes', 256 * 1024 * 1024);
});

test('startAgentStoreJobs runs the history copy after listen and finishes it', async () => {
  const db = fresh();
  copy.prepareHistoryCopy({ agentDb: db });
  const { copyDone } = jobs.startAgentStoreJobs({});
  const done = await copyDone;
  assert.equal(done, true);
  assert.equal(copy.historyCopyDone(), true);
  jobs.stopAgentStoreJobs();
});

test('shutdown path: queued rows are flushed by closeAgentDb, and stop/close are idempotent', () => {
  fresh();
  jobs.startAgentStoreJobs({});
  // Tool events go through the queue (activity is synchronous): one row queued.
  store.enqueueToolEvents(U, 'shutdown-run', { engine: 'v2', events: [{ tool: 'Read', resultChars: 1 }] });
  jobs.stopAgentStoreJobs();
  jobs.stopAgentStoreJobs();
  agent.closeAgentDb();
  agent.closeAgentDb();
  const reopened = agent.getAgentDb();
  assert.ok(reopened);
  assert.equal(count(reopened, "SELECT COUNT(*) AS n FROM agent_tool_events WHERE run_id = 'shutdown-run'"), 1);
});

test('a user purge flushes and drops that user\'s queued writes; other users keep theirs', () => {
  const db = fresh();
  store.enqueueToolEvents(U, 'purge-q-1', { engine: 'v2', events: [{ tool: 'Read', resultChars: 1 }] });
  store.enqueueToolEvents('u-keep', 'purge-q-2', { engine: 'v2', events: [{ tool: 'Read', resultChars: 1 }] });
  const r = store.purgeUserHistory(U);
  assert.equal(r.ok, true);
  agent.flushAgentQueue();
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM agent_tool_events WHERE run_id = 'purge-q-1'"), 0, 'no queued row lands after the purge');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM agent_tool_events WHERE run_id = 'purge-q-2'"), 1, 'other users are unaffected');
});
