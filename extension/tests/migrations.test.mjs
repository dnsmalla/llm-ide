// Integration-style test for the migration runner.  Uses an in-memory
// SQLite database so the suite runs in milliseconds and never touches
// the on-disk KB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { applyMigrations, migrationStatus } from '../kb/migrations.mjs';

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

test('first run applies all on-disk migrations', () => {
  const db = fresh();
  const r = applyMigrations(db);
  assert.ok(r.applied >= 2, `at least two migrations applied, got ${r.applied}`);
  const status = migrationStatus(db);
  assert.ok(status.current >= 2, `current version >= 2, got ${status.current}`);
});

test('second run is a no-op', () => {
  const db = fresh();
  applyMigrations(db);
  const r2 = applyMigrations(db);
  assert.equal(r2.applied, 0, 'rerun applies nothing');
});

test('schema_migrations table is created', () => {
  const db = fresh();
  applyMigrations(db);
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
  ).all();
  assert.equal(rows.length, 1);
});

test('migrations create expected core + multitenant tables', () => {
  const db = fresh();
  applyMigrations(db);
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r) => r.name);
  for (const t of [
    'meetings', 'entities', 'sources', 'plans', 'plan_tasks',
    'review_items', 'outcomes', 'users', 'refresh_tokens',
    'user_secrets', 'audit_log',
  ]) {
    assert.ok(tables.includes(t), `missing table: ${t}`);
  }
});

test('user_id columns exist on owned tables', () => {
  const db = fresh();
  applyMigrations(db);
  for (const t of ['meetings', 'entities', 'sources', 'plans', 'plan_tasks', 'review_items', 'outcomes']) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    assert.ok(cols.includes('user_id'), `${t} missing user_id`);
  }
});

test('legacy user is provisioned for pre-existing data', () => {
  const db = fresh();
  applyMigrations(db);
  const u = db.prepare("SELECT id FROM users WHERE id = 'legacy'").get();
  assert.ok(u, 'legacy user must exist');
});

test('FTS5 search table is created', () => {
  const db = fresh();
  applyMigrations(db);
  // FTS5 creates several auxiliary _* tables; the user-facing one is `search`.
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE name='search'"
  ).all();
  assert.equal(rows.length, 1);
});

test('triggers fire on insert (search index stays current)', () => {
  const db = fresh();
  applyMigrations(db);
  db.prepare(`
    INSERT INTO meetings (id, user_id, title, date, duration_sec, transcript)
    VALUES ('m1', 'legacy', 'Test meeting', '2026-05-01', 60, 'hello world')
  `).run();
  const hits = db.prepare(`
    SELECT meeting_id, title FROM search WHERE search MATCH 'world'
  `).all();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'Test meeting');
});
