// One-time copy of agent history from the main DB into agent.db (Stage 1b, T2.5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDb = path.join(__dirname, '_agent-history-copy-test.db');
process.env.LLMIDE_DB_PATH = tmpDb;
for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) fs.rmSync(f, { force: true });

const main = await import('../kb/db.mjs');
const agent = await import('../kb/agent-db.mjs');
const copy = await import('../kb/agent-history-copy.mjs');
const { recordActivity } = await import('../kb/activity.mjs');
const { config } = await import('../core/config.mjs');

// activity and the turn tables carry FKs to users: register real ones.
const users = await import('../server/users.mjs');
const U = users.registerUser(main.getDb(), { email: 'copy-a@example.test', password: 'CorrectHorseBattery', displayName: 'a' }).id;
const OTHER = users.registerUser(main.getDb(), { email: 'copy-b@example.test', password: 'CorrectHorseBattery', displayName: 'b' }).id;
const agentFiles = [config.agentDbPath, `${config.agentDbPath}-wal`, `${config.agentDbPath}-shm`];

// Seed the MAIN DB with the pre-release history (the tables still exist there).
function seedMain() {
  const db = main.getDb();
  for (const t of ['activity', 'activity_seen', 'turn_tool_events', 'turn_composition']) db.prepare(`DELETE FROM ${t}`).run();
  const ins = db.prepare("INSERT INTO activity (user_id, kind, title, created_at) VALUES (?, 'meeting_added', ?, '2026-10-20 09:00:00')");
  for (let i = 0; i < 5; i += 1) ins.run(U, `m${i}`);
  ins.run(OTHER, 'theirs');
  db.prepare('INSERT INTO activity_seen (user_id, last_seen_id) VALUES (?, 3)').run(U);
  const tool = db.prepare(`INSERT INTO turn_tool_events (user_id, turn_id, engine, seq, tool, result_chars, created_at)
    VALUES (?, ?, 'v2', ?, 'Read', 10, '2026-10-27T10:00:00.000Z')`);
  for (let i = 0; i < 7; i += 1) tool.run(U, `turn-${i % 3}`, i);
  const comp = db.prepare(`INSERT INTO turn_composition (user_id, turn_id, system_chars, created_at)
    VALUES (?, ?, ?, '2026-10-27T10:00:00.000Z')`);
  for (let i = 0; i < 3; i += 1) comp.run(U, `turn-${i}`, 100 + i);
}

function freshAgent() {
  agent.closeAgentDb();
  for (const f of agentFiles) fs.rmSync(f, { force: true });
  const db = agent.getAgentDb();
  assert.ok(db);
  return db;
}

const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const mainCounts = () => {
  const db = main.getDb();
  return {
    activity: count(db, 'SELECT COUNT(*) AS n FROM activity'),
    tools: count(db, 'SELECT COUNT(*) AS n FROM turn_tool_events'),
    comp: count(db, 'SELECT COUNT(*) AS n FROM turn_composition'),
    seen: count(db, 'SELECT COUNT(*) AS n FROM activity_seen'),
  };
};

function runAll(batch) {
  let steps = 0;
  for (;;) {
    const r = copy.copyHistoryStep({ batch });
    assert.equal(r.ok, true);
    if (r.done) return steps;
    steps += 1;
  }
}

test('prepare raises the id sequences above the main max, so new writes never collide', () => {
  seedMain();
  const db = freshAgent();
  const floors = copy.prepareHistoryCopy();
  assert.equal(typeof floors.activity, 'number');
  const newId = recordActivity({ userId: U, kind: 'meeting_added', title: 'new after boot' });
  assert.ok(newId > floors.activity, `new id ${newId} must be above the main max ${floors.activity}`);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM activity WHERE id = ?', newId), 1);
});

test('the copy keeps ids, days and cursors; the main DB is untouched', () => {
  seedMain();
  const before = mainCounts();
  const db = freshAgent();
  copy.prepareHistoryCopy();
  runAll(2);
  agent.flushAgentQueue();
  const ids = db.prepare('SELECT id FROM activity WHERE user_id = ? ORDER BY id').all(U).map((r) => r.id);
  const mainIds = main.getDb().prepare('SELECT id FROM activity WHERE user_id = ? ORDER BY id').all(U).map((r) => r.id);
  assert.deepEqual(ids, mainIds, 'activity ids are preserved');
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM activity'), before.activity);
  assert.equal(db.prepare('SELECT last_seen_id FROM activity_seen WHERE user_id = ?').get(U).last_seen_id, 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM agent_tool_events'), before.tools);
  const day = db.prepare('SELECT day, run_id FROM agent_tool_events LIMIT 1').get();
  assert.match(day.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(day.run_id, /^turn-/);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM turn_composition'), before.comp);
  assert.equal(db.prepare('SELECT system_chars FROM turn_composition WHERE turn_id = ?').get('turn-2').system_chars, 102);
  assert.deepEqual(mainCounts(), before, 'the main DB keeps every row');
  for (const t of ['activity', 'turn_tool_events', 'turn_composition']) {
    assert.equal(agent.readMeta(db, `copy_verified:${t}`), 'ok', `${t} verified`);
    assert.equal(agent.readMeta(db, `copy_done:${t}`), '1');
  }
  assert.equal(copy.historyCopyDone(), true);
});

test('the copy is idempotent: a second run copies nothing and changes nothing', () => {
  seedMain();
  const db = freshAgent();
  copy.prepareHistoryCopy();
  runAll(3);
  const total = () => count(db, 'SELECT COUNT(*) AS n FROM activity') + count(db, 'SELECT COUNT(*) AS n FROM agent_tool_events');
  const first = total();
  const r = copy.copyHistoryStep({ batch: 3 });
  assert.equal(r.done, true);
  assert.equal(r.copied, 0);
  assert.equal(total(), first);
});

test('a kill mid-copy resumes from the cursor with no duplicates', () => {
  seedMain();
  freshAgent();
  copy.prepareHistoryCopy();
  const r = copy.copyHistoryStep({ batch: 2 });
  assert.equal(r.copied, 2);
  // Simulate a crash and restart: close the store, reopen the same file.
  agent.closeAgentDb();
  const again = agent.getAgentDb();
  assert.ok(again);
  runAll(2);
  assert.equal(count(again, 'SELECT COUNT(*) AS n FROM activity'), mainCounts().activity);
  assert.equal(count(again, 'SELECT COUNT(*) AS n FROM agent_tool_events'), mainCounts().tools);
});

test('prepare skips tables already copied', () => {
  seedMain();
  freshAgent();
  copy.prepareHistoryCopy();
  runAll(100);
  assert.deepEqual(copy.prepareHistoryCopy(), {}, 'nothing left to prepare');
});

test('the read cursors are copied before listen, so the feed never shows copied rows as unread', async () => {
  seedMain();
  const db = freshAgent();
  copy.prepareHistoryCopy();
  // Only the prepare step has run: the activity rows are not copied yet, but
  // the read cursor is already in place.
  assert.equal(db.prepare('SELECT last_seen_id FROM activity_seen WHERE user_id = ?').get(U).last_seen_id, 3);
  assert.equal(count(db, 'SELECT COUNT(*) AS n FROM activity'), 0);
  runAll(2);
  const expectedUnread = main.getDb().prepare('SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND id > 3').get(U).n;
  const { unreadCount } = await import('../kb/activity.mjs');
  assert.equal(unreadCount(U), expectedUnread, 'unread is the rows after the cursor, nothing more');
});
