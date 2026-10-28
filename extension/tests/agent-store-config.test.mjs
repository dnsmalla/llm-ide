// agent.db path resolution and test isolation (plan T1.1), plus the
// migration runner's table/dir parameters (plan T1.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const LIVE_KB = path.join(ROOT, 'kb');

// Read config in a child process with a chosen environment, so the test
// does not depend on what this test process happened to import first.
function configIn(env) {
  const script = "import('./core/config.mjs').then(m=>process.stdout.write(JSON.stringify({agent:m.config.agentDbPath,main:m.config.dbPath})))";
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LLMIDE_JWT_SECRET: 'a'.repeat(48), LLMIDE_VAULT_KEY: 'b'.repeat(48), NODE_ENV: 'test' };
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: path.join(ROOT, 'extension'), env: { ...base, ...env }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout);
}

test('under the test runner the agent DB is a temp file, never the live kb/agent.db', () => {
  const cfg = configIn({ NODE_TEST_CONTEXT: '1' });
  assert.ok(cfg.agent.startsWith(os.tmpdir()), `agent path ${cfg.agent} is not in the temp dir`);
  assert.equal(cfg.agent, `${cfg.main}.agent.db`);
  assert.notEqual(cfg.agent, path.join(LIVE_KB, 'agent.db'));
  assert.notEqual(cfg.main, path.join(LIVE_KB, 'data.db'));
});

test('an explicit test DB path derives its agent DB beside it, not in kb/', () => {
  const cfg = configIn({ NODE_TEST_CONTEXT: '1', LLMIDE_DB_PATH: path.join(os.tmpdir(), 'x-test.db') });
  assert.equal(cfg.agent, path.join(os.tmpdir(), 'x-test.db.agent.db'));
});

test('production default: agent.db sits beside the main DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cfg-'));
  const cfg = configIn({ LLMIDE_DB_PATH: path.join(dir, 'data.db') });
  assert.equal(cfg.agent, path.join(dir, 'agent.db'));
});

test('LLMIDE_AGENT_DB_PATH overrides the derived path', () => {
  const cfg = configIn({ NODE_TEST_CONTEXT: '1', LLMIDE_AGENT_DB_PATH: path.join(os.tmpdir(), 'explicit-agent.db') });
  assert.equal(cfg.agent, path.join(os.tmpdir(), 'explicit-agent.db'));
});

test('migration runner: a second store gets its own directory and table', async () => {
  const { applyMigrations, migrationStatus } = await import('../kb/migrations.mjs');
  const Database = (await import('better-sqlite3')).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-dir-'));
  fs.writeFileSync(path.join(dir, '0001_probe.sql'), 'CREATE TABLE probe (id INTEGER PRIMARY KEY);');
  const db = new Database(path.join(dir, 'probe.db'));
  const res = applyMigrations(db, { dir, table: 'probe_migrations' });
  assert.deepEqual(res, { applied: 1, total: 1 });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  assert.ok(tables.includes('probe'));
  assert.ok(tables.includes('probe_migrations'));
  assert.ok(!tables.includes('schema_migrations'), 'the default table must not appear');
  assert.equal(migrationStatus(db, { table: 'probe_migrations' }).current, 1);
  // Re-run is a no-op.
  assert.equal(applyMigrations(db, { dir, table: 'probe_migrations' }).applied, 0);
  db.close();
});

test('migration runner rejects a table name that is not a plain identifier', async () => {
  const { applyMigrations } = await import('../kb/migrations.mjs');
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  assert.throws(() => applyMigrations(db, { table: 'x; DROP TABLE y' }), /invalid migrations table/);
  db.close();
});
