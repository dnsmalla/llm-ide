// agent.db schema (plan T1.3): the copied tables match the main DB's own
// columns, the store opens with the pragmas the plan asks for, and a second
// run of the migrations changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const { default: Database } = await import('better-sqlite3');
const { applyMigrations, AGENT_MIGRATIONS_DIR } = await import('../kb/migrations.mjs');
const agent = await import('../kb/agent-db.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-schema-'));
const cols = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all()
  .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`);

test('copied tables have the same columns as the main DB (day is the one addition)', () => {
  const main = new Database(path.join(tmp, 'main.db'));
  applyMigrations(main);
  const agentDb = new Database(path.join(tmp, 'agent-cols.db'));
  applyMigrations(agentDb, { dir: AGENT_MIGRATIONS_DIR, table: agent.AGENT_MIGRATIONS_TABLE });
  for (const table of ['turn_composition', 'activity', 'activity_seen']) {
    const want = cols(main, table);
    const got = cols(agentDb, table).filter((c) => !c.startsWith('day:'));
    assert.deepEqual(got, want, `${table} columns drifted from the main DB`);
  }
  // turn_composition gained `day` (the local day key), nothing else.
  assert.ok(cols(agentDb, 'turn_composition').some((c) => c.startsWith('day:')));
  main.close();
  agentDb.close();
});

test('agent-only tables exist with user_id and the expected keys', () => {
  const db = new Database(path.join(tmp, 'agent-tables.db'));
  applyMigrations(db, { dir: AGENT_MIGRATIONS_DIR, table: agent.AGENT_MIGRATIONS_TABLE });
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all().map((r) => r.name).sort();
  assert.deepEqual(names, [
    'activity', 'activity_seen', 'agent_daily', 'agent_daily_tools', 'agent_runs',
    'agent_schema_migrations', 'agent_tool_events', 'agent_user_settings', 'store_meta', 'turn_composition',
  ]);
  for (const t of names.filter((n) => !n.startsWith('agent_schema') && n !== 'store_meta')) {
    assert.ok(cols(db, t).some((c) => c.startsWith('user_id:')), `${t} has no user_id`);
  }
  assert.ok(!names.includes('usage_calls'), 'usage_calls is Stage 2');
  db.close();
});

test('re-running the migrations is a no-op', () => {
  const db = new Database(path.join(tmp, 'agent-rerun.db'));
  const first = applyMigrations(db, { dir: AGENT_MIGRATIONS_DIR, table: agent.AGENT_MIGRATIONS_TABLE });
  const second = applyMigrations(db, { dir: AGENT_MIGRATIONS_DIR, table: agent.AGENT_MIGRATIONS_TABLE });
  assert.equal(first.applied, 1);
  assert.equal(second.applied, 0);
  db.close();
});

test('openAgentDb: WAL, incremental auto_vacuum at creation, idempotent open and close', () => {
  const file = path.join(tmp, 'nested', 'agent.db');
  const db = agent.openAgentDb({ file });
  assert.ok(db, 'opens');
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('auto_vacuum', { simple: true }), 2, 'INCREMENTAL');
  assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
  assert.equal(db.pragma('synchronous', { simple: true }), 1, 'NORMAL');
  assert.equal(agent.openAgentDb({ file }), db, 'second open returns the same handle');
  assert.equal(agent.getAgentDb(), db);
  assert.equal(agent.agentStoreStatus().health, 'ok');
  agent.closeAgentDb();
  agent.closeAgentDb(); // idempotent
  assert.equal(agent.agentStoreStatus().state, 'closed');
  assert.equal(agent.getAgentDb({ file }) !== null, true, 'lazy reopen after close');
  agent.closeAgentDb();
});

test('localDay and localDayBefore use the local calendar date', () => {
  const d = new Date(2026, 9, 28, 23, 59, 59); // local 28 Oct 2026
  assert.equal(agent.localDay(d), '2026-10-28');
  assert.equal(agent.localDayBefore(d, 30), '2026-09-28');
  assert.equal(agent.localDayBefore(d, 0), '2026-10-28');
});
