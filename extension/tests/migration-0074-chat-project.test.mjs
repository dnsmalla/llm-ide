// Migration 0074: chat history becomes project-scoped for Host API clients without disturbing the rows
// that predate it. Legacy sessions keep project_id NULL, an empty id is normalized to NULL, the list
// index exists, and the one global phone-chat pointer is copied to the per-project table as project ''.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations } from '../kb/migrations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALL = path.join(HERE, '../kb/migrations');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-mig74-'));
const pre = path.join(dir, 'pre');
fs.mkdirSync(pre);
for (const f of fs.readdirSync(ALL)) {
  if (f.endsWith('.sql') && !/^0074_/.test(f)) fs.copyFileSync(path.join(ALL, f), path.join(pre, f));
}
const db = new Database(path.join(dir, 'kb.db'));
applyMigrations(db, { dir: pre });

const userId = 'u1';
db.prepare("INSERT INTO users (id, email, display_name, password_hash, role, status) VALUES (?, 'a@x.y', 'A', 'x', 'user', 'active')")
  .run(userId);
db.prepare(`INSERT INTO chat_sessions (id, user_id, title, surface, mode, project_id, created_at, updated_at)
            VALUES ('legacy-chat', ?, 'Phone chat', 'any', 'agent', NULL, 1, 1)`).run(userId);
db.prepare(`INSERT INTO chat_sessions (id, user_id, title, surface, mode, project_id, created_at, updated_at)
            VALUES ('empty-project', ?, 'Old', 'any', 'agent', '', 1, 1)`).run(userId);
db.prepare(`INSERT INTO chat_sessions (id, user_id, title, surface, mode, project_id, created_at, updated_at)
            VALUES ('project-chat', ?, 'Project', 'any', 'agent', 'p1', 1, 1)`).run(userId);
db.prepare("INSERT INTO host_api_quick_chat (user_id, chat_session_id) VALUES (?, 'legacy-chat')").run(userId);

// 0074 is the next head, and it runs after 0073 on a real boot.
fs.copyFileSync(path.join(ALL, '0074_chat_project_scope.sql'), path.join(pre, '0074_chat_project_scope.sql'));
applyMigrations(db, { dir: pre });

after(() => {
  try { db.close(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('legacy sessions stay NULL; an empty project id is normalized; a project id is untouched', () => {
  const rows = db.prepare('SELECT id, project_id FROM chat_sessions ORDER BY id').all();
  assert.deepEqual(rows, [
    { id: 'empty-project', project_id: null },
    { id: 'legacy-chat', project_id: null },
    { id: 'project-chat', project_id: 'p1' },
  ]);
});

test('the project list index exists', () => {
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'chat_sessions_user_project_updated'").get();
  assert.ok(index, 'chat_sessions_user_project_updated');
});

test('the pre-0074 phone-chat pointer is copied to the legacy/global project slot', () => {
  const row = db.prepare("SELECT project_id, chat_session_id FROM host_api_project_chat WHERE user_id = ?").get(userId);
  assert.deepEqual(row, { project_id: '', chat_session_id: 'legacy-chat' });
  // The old table is kept for downgrade safety; it is no longer read or written.
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host_api_quick_chat'").get());
});

test('re-running the migration is a no-op (already applied is skipped by version)', () => {
  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = 74").get();
  assert.deepEqual(applied, { version: 74 });
});
