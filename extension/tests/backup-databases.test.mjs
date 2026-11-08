// Paired backups: data.db + agent.db are written together and read back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-pair-'));
const dbPath = path.join(dir, 'data.db');
process.env.LLMIDE_DB_PATH = dbPath;
process.env.LLMIDE_JWT_SECRET = 'c'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'd'.repeat(48);

const kb = await import('../kb/db.mjs');
const agent = await import('../kb/agent-db.mjs');
const { backupDatabasesTo, agentBackupPath } = await import('../kb/backup-databases.mjs');

after(() => {
  try { kb.closeDb(); } catch { /* closed */ }
  try { agent.closeAgentDb(); } catch { /* closed */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writes data.db and agent.db as a pair, with the agent history in the second file', () => {
  const db = kb.getDb();
  const adb = agent.getAgentDb();
  assert.ok(adb, 'agent.db opened');
  adb.prepare(`INSERT INTO agent_runs (run_id, user_id, day, source, status, started_at)
               VALUES ('run-1', 'u1', '2026-11-08', 'chat', 'ok', '2026-11-08T00:00:00.000Z')`).run();

  const target = path.join(dir, 'backups', 'data-1700000000.db');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const made = backupDatabasesTo(target);
  assert.equal(made.path, target);
  assert.ok(made.bytes > 0);
  assert.equal(made.agentPath, agentBackupPath(target));
  assert.ok(made.agentBytes > 0);

  const copy = new Database(target, { readonly: true });
  try {
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
    assert.ok(copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get());
  } finally { copy.close(); }
  const acopy = new Database(made.agentPath, { readonly: true });
  try {
    assert.equal(acopy.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal(acopy.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1);
  } finally { acopy.close(); }
  // The pair uses the naming retention groups on.
  assert.match(path.basename(made.agentPath), /^data-\d+\.agent\.db$/);
  void db;
});
