// agent store retention (plan Phase 3 store core): rollup, clear with dry
// run and preview check, compact, storage stats, settings, user purge and the
// recording helpers. Temp files only.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const agent = await import('../kb/agent-db.mjs');
const store = await import('../kb/agent-store.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retention-'));
const file = path.join(tmp, 'agent.db');
// A fixed "now": local noon on 2026-10-28, so local-day arithmetic is simple.
const NOW = new Date(2026, 9, 28, 12, 0, 0);
const DAY = (n) => agent.localDayBefore(NOW, n); // n days before NOW

let db;
beforeEach(() => {
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
  db = agent.openAgentDb({ file });
  assert.ok(db);
});

function insertRun(user, { id, day, source = 'chat', provider = 'anthropic', model = 'm1', status = 'ok', tokens = 10, tools = 2 }) {
  db.prepare(`INSERT INTO agent_runs (run_id, user_id, day, source, provider, model, status, started_at, ended_at,
      duration_ms, tool_calls, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:01Z', 100, ?, ?, ?, 1, 2)`)
    .run(id, user, day, source, provider, model, status, tools, tokens, tokens + 1);
}
function insertTool(user, { runId, day, tool = 'Read', isError = 0 }) {
  db.prepare(`INSERT INTO agent_tool_events (user_id, run_id, day, engine, seq, tool, result_chars, is_error)
    VALUES (?, ?, ?, 'v2', 0, ?, 5, ?)`).run(user, runId, day, tool, isError);
}
function insertComposition(user, { turnId, day }) {
  db.prepare(`INSERT INTO turn_composition (user_id, turn_id, day, mode) VALUES (?, ?, ?, 'plan')`).run(user, turnId, day);
}
const count = (t, user) => db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(user).n;

test('rollup folds old runs into agent_daily and deletes the raw rows', () => {
  insertRun('u1', { id: 'old1', day: DAY(45), tokens: 10 });
  insertRun('u1', { id: 'old2', day: DAY(45), tokens: 5, status: 'error' });
  insertRun('u1', { id: 'recent', day: DAY(3) });
  const res = store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(res.runsFolded, 2);
  assert.equal(count('agent_runs', 'u1'), 1, 'the recent run stays raw');
  const daily = db.prepare('SELECT * FROM agent_daily WHERE user_id = ? AND day = ?').get('u1', DAY(45));
  assert.equal(daily.runs, 2);
  assert.equal(daily.runs_error, 1);
  assert.equal(daily.input_tokens, 10 + 5);
  assert.equal(daily.cache_creation_tokens, 4);
  assert.equal(daily.tool_calls, 4);
});

test('rollup is idempotent: a second run changes nothing', () => {
  insertRun('u1', { id: 'old1', day: DAY(40) });
  insertTool('u1', { runId: 'old1', day: DAY(40) });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  const before = db.prepare('SELECT * FROM agent_daily ORDER BY day').all();
  const again = store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(again.runsFolded, 0);
  assert.equal(again.toolEventsFolded, 0);
  assert.deepEqual(db.prepare('SELECT * FROM agent_daily ORDER BY day').all(), before);
});

test('open runs are never folded, even when old', () => {
  insertRun('u1', { id: 'stuck', day: DAY(60), status: 'running' });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(count('agent_runs', 'u1'), 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_daily').get().n, 0);
});

test('tool events fold into agent_daily_tools per engine and tool', () => {
  insertTool('u1', { runId: 'a', day: DAY(50), tool: 'Read' });
  insertTool('u1', { runId: 'a', day: DAY(50), tool: 'Read', isError: 1 });
  insertTool('u1', { runId: 'a', day: DAY(50), tool: 'Bash' });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(count('agent_tool_events', 'u1'), 0);
  const read = db.prepare("SELECT calls, errors FROM agent_daily_tools WHERE tool = 'Read'").get();
  assert.deepEqual({ ...read }, { calls: 2, errors: 1 });
});

test('composition: the newest 50 turns stay raw whatever their age', () => {
  for (let i = 0; i < 60; i += 1) insertComposition('u1', { turnId: `t${i}`, day: DAY(90) });
  const res = store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(res.compositionsPruned, 10);
  assert.equal(count('turn_composition', 'u1'), 50);
  const oldest = db.prepare('SELECT MIN(turn_id) AS m FROM turn_composition').get().m;
  assert.equal(oldest, 't10', 'the 10 oldest went, the newest 50 stayed');
});

test('daily rows older than 400 days are dropped', () => {
  insertRun('u1', { id: 'ancient', day: DAY(420) });
  const first = store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(first.dailyPurged, 1, 'folded and dropped in the same pass: older than 400 days');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_daily WHERE day = ?').get(DAY(420)).n, 0);
  insertRun('u1', { id: 'x', day: DAY(35) });
  const second = store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(second.dailyPurged, 0, 'nothing else is past 400 days');
});

test('rollup is per user: another user keeps their raw rows', () => {
  insertRun('u1', { id: 'a', day: DAY(45) });
  insertRun('u2', { id: 'b', day: DAY(45) });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.equal(count('agent_runs', 'u1'), 0);
  assert.equal(count('agent_runs', 'u2'), 1);
});

test('rollupAll uses each user retention setting', () => {
  store.setRetentionDays('u1', 7, { db, now: NOW });
  insertRun('u1', { id: 'a', day: DAY(10) });
  insertRun('u2', { id: 'b', day: DAY(10) });
  const res = store.rollupAll({ db, now: NOW });
  assert.equal(res.ok, true);
  assert.equal(count('agent_runs', 'u1'), 0, 'u1 keeps 7 days so the 10-day-old run is folded');
  assert.equal(count('agent_runs', 'u2'), 1, 'u2 keeps the default 30 days');
  assert.ok(agent.readMeta(db, 'last_rollup_at'));
});

test('retention settings clamp to 7..365, default 30, and never delete on change', () => {
  assert.equal(store.getRetentionSettings('u1', { db }).retentionDays, 30);
  assert.equal(store.setRetentionDays('u1', 1, { db, now: NOW }).retentionDays, 7);
  assert.equal(store.setRetentionDays('u1', 9999, { db, now: NOW }).retentionDays, 365);
  assert.equal(store.setRetentionDays('u1', 90.7, { db, now: NOW }).retentionDays, 90);
  assert.throws(() => store.setRetentionDays('u1', 'abc', { db, now: NOW }), TypeError);
  insertRun('u1', { id: 'a', day: DAY(20) });
  store.setRetentionDays('u1', 7, { db, now: NOW });
  assert.equal(count('agent_runs', 'u1'), 1, 'changing retention never deletes synchronously');
  store.rollupOlderThan('u1', 7, { db, now: NOW });
  assert.equal(count('agent_runs', 'u1'), 0, 'lowering retention rolls up on the next run');
  store.setRetentionDays('u1', 365, { db, now: NOW });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_daily').get().n, 1, 'raising never restores raw rows');
});

test('clear: dry run deletes nothing and reports what a real run would delete', () => {
  insertRun('u1', { id: 'a', day: DAY(2) });
  insertRun('u1', { id: 'b', day: DAY(40) });
  insertTool('u1', { runId: 'a', day: DAY(2) });
  insertRun('u1', { id: 'open', day: DAY(2), status: 'running' });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  const preview = store.clearHistory('u1', { scope: 'raw', dryRun: true, db, now: NOW });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.wouldDelete.agent_runs, 1, 'the open run is not counted');
  assert.equal(preview.wouldDelete.agent_tool_events, 1);
  assert.equal(preview.wouldDelete.agent_daily, 0, 'raw scope keeps rollups');
  assert.equal(count('agent_runs', 'u1'), 2, 'dry run deleted nothing');
  const real = store.clearHistory('u1', { scope: 'raw', dryRun: false, expectCounts: preview.wouldDelete, db, now: NOW });
  assert.equal(real.ok, true);
  assert.deepEqual(real.deleted, preview.wouldDelete, 'the dry run matches the real run');
  assert.equal(count('agent_runs', 'u1'), 1, 'only the open run remains');
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM agent_daily').get().n > 0, 'daily kept');
});

test('clear: a changed count since the preview refuses with preview_stale', () => {
  insertRun('u1', { id: 'a', day: DAY(2) });
  const preview = store.clearHistory('u1', { scope: 'raw', dryRun: true, db, now: NOW });
  insertRun('u1', { id: 'b', day: DAY(2) });
  const res = store.clearHistory('u1', { scope: 'raw', dryRun: false, expectCounts: preview.wouldDelete, db, now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'preview_stale');
  assert.equal(count('agent_runs', 'u1'), 2, 'nothing deleted');
});

test('clear scope all removes rollups too and resets the watermark without beforeDays', () => {
  insertRun('u1', { id: 'a', day: DAY(45) });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  assert.ok(db.prepare("SELECT last_rolled_day FROM agent_user_settings WHERE user_id = 'u1'").get().last_rolled_day);
  const res = store.clearHistory('u1', { scope: 'all', dryRun: false, db, now: NOW });
  assert.equal(res.deleted.agent_daily, 1);
  assert.equal(db.prepare("SELECT last_rolled_day, last_cleared_scope FROM agent_user_settings WHERE user_id = 'u1'").get().last_rolled_day, null);
});

test('clear with beforeDays keeps the newer days', () => {
  insertRun('u1', { id: 'a', day: DAY(2) });
  insertRun('u1', { id: 'b', day: DAY(20) });
  const res = store.clearHistory('u1', { scope: 'raw', beforeDays: 10, dryRun: false, db, now: NOW });
  assert.equal(res.deleted.agent_runs, 1);
  assert.equal(count('agent_runs', 'u1'), 1);
});

test('clear never touches another user or the activity feed', () => {
  insertRun('u1', { id: 'a', day: DAY(2) });
  insertRun('u2', { id: 'b', day: DAY(2) });
  db.prepare("INSERT INTO activity (user_id, kind, title) VALUES ('u1', 'k', 't')").run();
  store.clearHistory('u1', { scope: 'all', dryRun: false, db, now: NOW });
  assert.equal(count('agent_runs', 'u2'), 1);
  assert.equal(count('activity', 'u1'), 1);
});

test('clear rejects an unknown scope', () => {
  assert.throws(() => store.clearHistory('u1', { scope: 'everything', db }), TypeError);
});

test('compact: incremental slices yield to timers and a busy store refuses', async () => {
  // Make freelist pages: insert a lot, then delete it.
  const big = db.prepare('INSERT INTO activity (user_id, kind, title, detail) VALUES (?, ?, ?, ?)');
  const blob = 'x'.repeat(2000);
  db.transaction(() => { for (let i = 0; i < 3000; i += 1) big.run('u1', 'k', 't', blob); })();
  db.prepare('DELETE FROM activity').run();
  assert.ok(db.pragma('freelist_count', { simple: true }) > 0);

  let timerFired = 0;
  const timer = setInterval(() => { timerFired += 1; }, 0);
  const res = await store.compact({ db, file, slicePages: 5, sliceMs: 5000, freeSpace: () => 1e12, yieldFn: () => new Promise((r) => { setTimeout(r, 0); }) });
  clearInterval(timer);
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'incremental');
  assert.ok(res.pagesFreed > 0);
  assert.ok(timerFired > 0, 'a timer fired between slices');
  assert.equal(db.pragma('freelist_count', { simple: true }), 0);

  const busy = await store.compact({ db, file, inFlight: () => true });
  assert.equal(busy.reason, 'busy');
});

test('compact refuses when a run is in flight, without starting work', async () => {
  const res = await store.compact({ db, file, inFlight: () => true });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'busy');
});

test('storage stats: exact file size, per-user counts, estimated bytes flagged approx', () => {
  insertRun('u1', { id: 'a', day: DAY(45) });
  insertRun('u2', { id: 'b', day: DAY(2) });
  store.rollupOlderThan('u1', 30, { db, now: NOW });
  const st = store.storageStats('u1', { db, now: NOW });
  assert.equal(st.ok, true);
  assert.equal(st.user.bytesIsApprox, true);
  assert.equal(st.user.rows.agent_daily, 1);
  assert.equal(st.user.rows.agent_runs, 0);
  assert.equal(st.user.rolledDays, 1);
  assert.equal(st.user.retentionDays, 30);
  assert.ok(st.file.bytes > 0);
  assert.ok(st.file.pageSize > 0);
  assert.equal(st.store.health, 'ok');
});

test('purgeUser removes every row for one user in every user table', () => {
  insertRun('u1', { id: 'a', day: DAY(2) });
  insertRun('u2', { id: 'b', day: DAY(2) });
  insertTool('u1', { runId: 'a', day: DAY(2) });
  insertComposition('u1', { turnId: 'a', day: DAY(2) });
  db.prepare("INSERT INTO activity (user_id, kind, title) VALUES ('u1', 'k', 't')").run();
  db.prepare("INSERT INTO activity_seen (user_id, last_seen_id) VALUES ('u1', 3)").run();
  store.rollupOlderThan('u1', 1, { db, now: NOW });
  store.setRetentionDays('u1', 60, { db, now: NOW });
  const res = store.purgeUser('u1', { db });
  assert.equal(res.ok, true);
  for (const t of store.AGENT_USER_TABLES) {
    assert.equal(count(t, 'u1'), 0, `${t} still has u1 rows`);
  }
  assert.equal(count('agent_runs', 'u2'), 1, 'other users are untouched');
  assert.equal(store.purgeUser('u1', { db }).ok, true, 'idempotent');
});

test('recording helpers: open run, close once, tool events capped, composition column whitelist', () => {
  assert.equal(store.openRun('u1', { runId: 'r1', source: 'chat', engine: 'v2', provider: 'anthropic', model: 'm' }, { db, now: NOW }), true);
  assert.equal(store.openRun('u1', { runId: 'r2', source: 'nope' }, { db, now: NOW }), false, 'unknown source refused');
  const row = db.prepare("SELECT status, day FROM agent_runs WHERE run_id = 'r1'").get();
  assert.deepEqual({ ...row }, { status: 'running', day: agent.localDay(NOW) });

  store.enqueueRunClose('u1', 'r1', { status: 'ok', durationMs: 5, toolCalls: 1, inputTokens: 7, outputTokens: 3, endedAt: NOW });
  store.enqueueRunClose('u1', 'r1', { status: 'error', inputTokens: 999 });
  agent.flushAgentQueue();
  const closed = db.prepare("SELECT status, input_tokens FROM agent_runs WHERE run_id = 'r1'").get();
  assert.deepEqual({ ...closed }, { status: 'ok', input_tokens: 7 }, 'the second close is a no-op');

  const events = Array.from({ length: 250 }, (_, i) => ({ tool: `T${i}`, resultChars: i }));
  assert.equal(store.enqueueToolEvents('u1', 'r1', { engine: 'v2', events }), 200);
  agent.flushAgentQueue();
  assert.equal(count('agent_tool_events', 'u1'), 200);

  assert.equal(store.enqueueTurnComposition('u1', { turnId: 'r1', columns: { mode: 'plan', bogus_col: 'x', 'user_id; DROP': 1 } }, { db }), true);
  agent.flushAgentQueue();
  const comp = db.prepare("SELECT mode FROM turn_composition WHERE turn_id = 'r1'").get();
  assert.equal(comp.mode, 'plan');
});

test('requireUser: every per-user helper refuses a missing user', () => {
  assert.throws(() => store.rollupOlderThan('', 30, { db }), /userId is required/);
  assert.throws(() => store.clearHistory(undefined, { scope: 'raw', db }), /userId is required/);
  assert.throws(() => store.purgeUser(null, { db }), /userId is required/);
});
