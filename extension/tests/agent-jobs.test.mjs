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
  // The quarantine test leaves corrupt copies beside the test store: remove them.
  const dir = path.dirname(config.agentDbPath);
  const base = path.basename(config.agentDbPath) + '.corrupt-';
  for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.rmSync(path.join(dir, f), { force: true });
});

test('openAgentStoreAtBoot opens the store, raises the id floors and reports ok', () => {
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const r = jobs.openAgentStoreAtBoot({});
  assert.equal(r.ok, true);
  assert.equal(agent.agentStoreStatus().state, 'ok');
});

test('at boot every run still running from a previous process is closed as aborted', () => {
  const db = fresh();
  // Rows a previous process left open, however recent: no run of this process exists at boot.
  openRun(U, { runId: 'prev-old', source: 'chat', engine: 'v2' }, { now: new Date(Date.now() - 25 * 60 * 60 * 1000) });
  openRun(U, { runId: 'prev-recent', source: 'chat', engine: 'v2' });
  agent.flushAgentQueue();
  assert.equal(store.abortStaleRuns({ db }), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").get().n, 0);
  assert.equal(db.prepare("SELECT error_code FROM agent_runs WHERE run_id = 'prev-recent'").get().error_code, 'stale_run');
});

test('an operator sweep with a window keeps the recent running rows', () => {
  const db = fresh();
  openRun(U, { runId: 'win-old', source: 'chat', engine: 'v2' }, { now: new Date(Date.now() - 25 * 60 * 60 * 1000) });
  openRun(U, { runId: 'win-recent', source: 'chat', engine: 'v2' });
  agent.flushAgentQueue();
  assert.equal(store.abortStaleRuns({ db, olderThanMs: 24 * 60 * 60 * 1000 }), 1);
  assert.equal(db.prepare("SELECT status FROM agent_runs WHERE run_id = 'win-recent'").get().status, 'running');
});

test('an account delete while agent.db is down leaves a main-DB marker; boot replays it and clears it', async () => {
  fresh();
  const gone = users.registerUser(main.getDb(), { email: 'jobs-gone@example.test', password: 'CorrectHorseBattery', displayName: 'g' }).id;
  recordActivity({ userId: gone, kind: 'meeting_added', title: 'history of a deleted account' });
  agent.flushAgentQueue();
  // Make agent.db unavailable: a path under a regular file cannot be created.
  agent.closeAgentDb();
  agent.openAgentDb({ file: path.join(tmpDb, 'agent.db') });
  assert.equal(agent.getAgentDb(), null, 'the store is down');
  main.deleteUserCascade(gone);
  const marker = () => main.getDb().prepare('SELECT COUNT(*) AS n FROM pending_agent_purges WHERE deleted_user_id = ?').get(gone).n;
  assert.equal(marker(), 1, 'the purge is recorded in the main DB, so it is not lost');
  // The store comes back; the next boot replays the purge and clears the marker.
  agent.closeAgentDb();
  const back = agent.getAgentDb();      // reopen the same file: the history is still there
  assert.ok(back);
  assert.ok(count(back, 'SELECT COUNT(*) AS n FROM activity WHERE user_id = ?', gone) >= 1, 'the history survived the outage');
  jobs.openAgentStoreAtBoot({});
  assert.equal(count(back, 'SELECT COUNT(*) AS n FROM activity WHERE user_id = ?', gone), 0, 'boot replayed the purge');
  assert.equal(marker(), 0, 'the marker is cleared on success');
});

test('an account delete with agent.db up leaves no marker', () => {
  fresh();
  const u = users.registerUser(main.getDb(), { email: 'jobs-clean@example.test', password: 'CorrectHorseBattery', displayName: 'c' }).id;
  main.deleteUserCascade(u);
  assert.equal(main.getDb().prepare('SELECT COUNT(*) AS n FROM pending_agent_purges WHERE deleted_user_id = ?').get(u).n, 0);
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

test('after a quarantine, the fresh store gets new id floors and the history copy runs again', () => {
  fresh();
  const u = users.registerUser(main.getDb(), { email: 'jobs-fresh@example.test', password: 'CorrectHorseBattery', displayName: 'f' }).id;
  const mainMax = () => main.getDb().prepare('SELECT COALESCE(MAX(id),0) AS m FROM activity').get().m;
  main.getDb().prepare("INSERT INTO activity (user_id, kind, title) VALUES (?, 'meeting_added', 'before quarantine')").run(u);
  main.getDb().prepare("INSERT INTO activity (user_id, kind, title) VALUES (?, 'meeting_added', 'before quarantine 2')").run(u);
  // Garbage at the store path: the next open quarantines and recreates the file.
  agent.closeAgentDb();
  fs.writeFileSync(config.agentDbPath, Buffer.from('not a sqlite file at all, just garbage bytes'));
  jobs.openAgentStoreAtBoot({});
  const db = agent.getAgentDb();
  assert.ok(db);
  const newId = recordActivity({ userId: u, kind: 'meeting_added', title: 'after quarantine' });
  assert.ok(newId > mainMax(), `new id ${newId} must be above the main max ${mainMax()}`);
  copy.runHistoryCopy();
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND id <= ?', u, mainMax()), 2, 'the copy re-ran on the fresh file');
});
