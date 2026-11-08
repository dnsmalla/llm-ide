// Verified restore of a data.db + agent.db backup pair (kb/restore-backup.mjs).
// Temp dirs only; the live files are fixtures, never a real data dir.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { restoreBackup } from '../kb/restore-backup.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'restore-backup.mjs');
let dir;
let liveData;
let liveAgent;
let backupData;
let backupAgent;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-restore-'));
  liveData = path.join(dir, 'data.db');
  liveAgent = path.join(dir, 'agent.db');
  backupData = path.join(dir, 'backup-data.db');
  backupAgent = path.join(dir, 'backup-data.agent.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeData(file, users) {
  const db = new Database(file);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT); CREATE TABLE users (id TEXT PRIMARY KEY);');
  db.prepare("INSERT INTO schema_migrations VALUES (69, 'test')").run();
  for (const u of users) db.prepare('INSERT INTO users (id) VALUES (?)').run(u);
  db.close();
}
function makeAgent(file, runs) {
  const db = new Database(file);
  db.exec('CREATE TABLE agent_schema_migrations (version INTEGER PRIMARY KEY, name TEXT); CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, outcome TEXT);');
  db.prepare("INSERT INTO agent_schema_migrations VALUES (4, 'test')").run();
  for (const r of runs) db.prepare('INSERT INTO agent_runs (outcome) VALUES (?)').run(r);
  db.close();
}
function rows(file, sql) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
}
function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
const mainHashes = () => ({ data: sha(liveData), agent: sha(liveAgent) });

function fixtures() {
  makeData(backupData, ['old-a', 'old-b']);
  makeAgent(backupAgent, ['old-run']);
  makeData(liveData, ['new-a']);
  makeAgent(liveAgent, ['new-run']);
}

test('restores the pair and keeps a pre-restore snapshot of each old file', () => {
  fixtures();
  const r = restoreBackup({ backupPath: backupData, dbPath: liveData, agentBackupPath: backupAgent, agentDbPath: liveAgent });
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.deepEqual(rows(liveData, 'SELECT id FROM users ORDER BY id').map((x) => x.id), ['old-a', 'old-b']);
  assert.deepEqual(rows(liveAgent, 'SELECT outcome FROM agent_runs').map((x) => x.outcome), ['old-run']);
  assert.equal(r.preRestore.length, 2);
  for (const p of r.preRestore) assert.ok(fs.existsSync(p), p);
  assert.deepEqual(rows(r.preRestore[0], 'SELECT id FROM users ORDER BY id').map((x) => x.id), ['new-a']);
  assert.deepEqual(rows(r.preRestore[1], 'SELECT outcome FROM agent_runs').map((x) => x.outcome), ['new-run']);
});

test('a corrupt data backup is refused and both live files are untouched', () => {
  fixtures();
  const before = mainHashes();
  const bad = path.join(dir, 'bad.db');
  fs.writeFileSync(bad, Buffer.from('not a database'));
  const r = restoreBackup({ backupPath: bad, dbPath: liveData, agentBackupPath: backupAgent, agentDbPath: liveAgent });
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'backup-invalid');
  assert.deepEqual(mainHashes(), before);
});

test('an invalid agent backup refuses before data.db is touched', () => {
  fixtures();
  const before = mainHashes();
  const bad = path.join(dir, 'bad-agent.db');
  fs.writeFileSync(bad, Buffer.from('not a database'));
  const r = restoreBackup({ backupPath: backupData, dbPath: liveData, agentBackupPath: bad, agentDbPath: liveAgent });
  assert.equal(r.status, 'refused');
  assert.equal(r.reason, 'agent-backup-invalid');
  assert.deepEqual(mainHashes(), before);
});

test('a failure after replacing both files rolls both halves back', () => {
  fixtures();
  const before = mainHashes();
  const r = restoreBackup({
    backupPath: backupData, dbPath: liveData, agentBackupPath: backupAgent, agentDbPath: liveAgent,
    fault: (step) => { if (step === 'verify:agent') throw new Error('injected verification failure'); },
  });
  assert.equal(r.status, 'failed');
  assert.deepEqual(mainHashes(), before, 'data.db and agent.db are exactly as before');
});

test('a data-only restore leaves agent.db alone', () => {
  fixtures();
  const agentBefore = sha(liveAgent);
  const r = restoreBackup({ backupPath: backupData, dbPath: liveData });
  assert.equal(r.status, 'completed');
  assert.equal(sha(liveAgent), agentBefore);
  assert.deepEqual(rows(liveData, 'SELECT id FROM users ORDER BY id').map((x) => x.id), ['old-a', 'old-b']);
});

test('a live data.db held by a writer is refused', () => {
  fixtures();
  const before = mainHashes();
  const held = new Database(liveData, { timeout: 0 });
  held.exec('BEGIN IMMEDIATE');
  try {
    const r = restoreBackup({ backupPath: backupData, dbPath: liveData, agentBackupPath: backupAgent, agentDbPath: liveAgent });
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'live-in-use');
  } finally {
    held.exec('ROLLBACK');
    held.close();
  }
  assert.deepEqual(mainHashes(), before);
});

test('the CLI is a verified dry run without --yes, and restores with it', () => {
  fixtures();
  const env = {
    ...process.env,
    LLMIDE_DB_PATH: liveData,
    LLMIDE_AGENT_DB_PATH: liveAgent,
    LLMIDE_JWT_SECRET: 'e'.repeat(48),
    LLMIDE_VAULT_KEY: 'f'.repeat(48),
  };
  const dry = spawnSync(process.execPath, [CLI, '--backup', backupData, '--agent', backupAgent, '--json'], { encoding: 'utf8', env });
  assert.equal(dry.status, 2, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.status, 'dry-run');
  assert.deepEqual(rows(liveData, 'SELECT id FROM users ORDER BY id').map((x) => x.id), ['new-a'], 'dry run changed nothing');

  const run = spawnSync(process.execPath, [CLI, '--backup', backupData, '--agent', backupAgent, '--db', liveData, '--agent-db', liveAgent, '--yes', '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'completed');
  assert.deepEqual(rows(liveData, 'SELECT id FROM users ORDER BY id').map((x) => x.id), ['old-a', 'old-b']);
});
