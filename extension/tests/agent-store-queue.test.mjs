// agent.db write queue (plan T1.4) and size watchdog (plan T1.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const { default: Database } = await import('better-sqlite3');
const agent = await import('../kb/agent-db.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-queue-'));
const file = path.join(tmp, 'agent.db');
const TOOL_SQL = `INSERT INTO agent_tool_events (user_id, run_id, day, engine, seq, tool) VALUES (?, ?, ?, ?, ?, ?)`;
const ACT_SQL = `INSERT INTO activity (user_id, kind, title) VALUES (?, ?, ?)`;

function fresh() {
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const db = agent.openAgentDb({ file });
  assert.ok(db);
  return db;
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('queued rows are written in enqueue order across batch boundaries', () => {
  const db = fresh();
  for (let i = 0; i < 450; i += 1) {
    assert.equal(agent.enqueueAgentWrite('tool_events', TOOL_SQL, ['u1', 'r1', '2026-10-28', 'v2', i, `t${i}`]), true);
  }
  assert.equal(agent.agentStoreStatus().queued, 450);
  assert.equal(agent.flushAgentQueue(), 450);
  const seqs = db.prepare('SELECT seq FROM agent_tool_events ORDER BY id').all().map((r) => r.seq);
  assert.equal(seqs.length, 450);
  assert.ok(seqs.every((s, i) => s === i), 'order preserved');
  assert.equal(agent.agentStoreStatus().queued, 0);
});

test('the queue is capped at 5,000: the oldest row goes and the drop is counted and persisted', () => {
  const db = fresh();
  for (let i = 0; i < 5005; i += 1) agent.enqueueAgentWrite('activity', ACT_SQL, ['u1', 'k', `t${i}`]);
  assert.equal(agent.agentStoreStatus().queued, 5000);
  assert.equal(agent.agentStoreStatus().droppedThisProcess, 5);
  assert.equal(agent.flushAgentQueue(), 5000);
  assert.equal(count(db, 'activity'), 5000);
  const first = db.prepare('SELECT title FROM activity ORDER BY id LIMIT 1').get();
  assert.equal(first.title, 't5', 'the five oldest were dropped');
  assert.equal(agent.agentStoreStatus().droppedRows, 5);
  assert.equal(agent.readMeta(db, 'dropped_rows'), '5');
});

test('closing flushes everything queued first: no lost rows', () => {
  fresh();
  for (let i = 0; i < 10; i += 1) agent.enqueueAgentWrite('activity', ACT_SQL, ['u1', 'k', `c${i}`]);
  agent.closeAgentDb();
  const raw = new Database(file, { readonly: true });
  assert.equal(count(raw, 'activity'), 10);
  raw.close();
});

test('enqueue never throws on bad input and reports false', () => {
  fresh();
  assert.equal(agent.enqueueAgentWrite('nope', ACT_SQL, []), false);
  assert.equal(agent.enqueueAgentWrite('activity', 42, []), false);
  assert.equal(agent.enqueueAgentWrite('activity', ACT_SQL, 'not-an-array'), false);
});

test('a failing handle never throws into the caller and counts the loss', () => {
  const failing = {
    prepare() { throw new Error('disk I/O error'); },
    transaction() { return () => { throw new Error('disk I/O error'); }; },
    pragma() { return 'ok'; },
    close() {},
  };
  agent.closeAgentDb();
  agent.setAgentDbForTests(failing);
  // Counters are per process, so compare against the values before this test.
  const before = agent.agentStoreStatus();
  assert.doesNotThrow(() => {
    assert.equal(agent.enqueueAgentWrite('activity', ACT_SQL, ['u1', 'k', 'x']), true);
    assert.equal(agent.flushAgentQueue(), 0);
  });
  const st = agent.agentStoreStatus();
  assert.equal(st.writeErrors - before.writeErrors, 1);
  assert.equal(st.droppedThisProcess - before.droppedThisProcess, 1);
  assert.equal(st.health, 'degraded');
  agent.setAgentDbForTests(null);
});

test('a store that cannot open is down: boot does not fail and writes are dropped', () => {
  agent.closeAgentDb();
  agent.setAgentDbForTests(null);
  const blocker = path.join(tmp, 'a-file');
  fs.writeFileSync(blocker, 'x');
  // The parent of the store path is a regular file, so the directory cannot exist.
  const db = agent.openAgentDb({ file: path.join(blocker, 'agent.db') });
  assert.equal(db, null);
  assert.equal(agent.agentStoreStatus().health, 'down');
  assert.equal(agent.getAgentDb(), null);
  assert.equal(agent.enqueueAgentWrite('activity', ACT_SQL, ['u1', 'k', 'x']), false);
  assert.equal(agent.flushAgentQueue(), 0);
  agent.setAgentDbForTests(null);
});

test('size watchdog: soft requests a rollup, hard stops tool-event and composition writes only', () => {
  const db = fresh();
  agent.writeMeta(db, 'soft_bytes', 1);
  assert.equal(agent.checkStorageSize().state, 'soft');
  assert.equal(agent.takeRollupRequest(), true);
  assert.equal(agent.takeRollupRequest(), false, 'the request is taken once');

  agent.writeMeta(db, 'hard_bytes', 1);
  assert.equal(agent.checkStorageSize().state, 'hard');
  assert.equal(agent.enqueueAgentWrite('tool_events', TOOL_SQL, ['u1', 'r', 'd', 'v2', 0, 't']), false);
  assert.equal(agent.enqueueAgentWrite('composition', ACT_SQL, ['u1', 'k', 'x']), false);
  assert.equal(agent.enqueueAgentWrite('runs', ACT_SQL, ['u1', 'k', 'x']), true, 'run closes keep working');
  assert.equal(agent.enqueueAgentWrite('activity', ACT_SQL, ['u1', 'k', 'x']), true, 'activity keeps working');
  agent.flushAgentQueue();
  assert.equal(count(db, 'activity'), 2);
  assert.equal(agent.agentStoreStatus().sizeState, 'hard');
  agent.closeAgentDb();
});
