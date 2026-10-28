// One-time copy of <repo>/kb into LLMIDE_DATA_DIR (kb/data-dir-migration.mjs).
// Temp dirs only: never the real kb/.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { runDataDirMigration } from '../kb/data-dir-migration.mjs';
import { getDataDirOverride, clearDataDirOverride, getDataMigrationReport } from '../core/data-dir.mjs';

let work;
let root;      // fake repo root (holds kb/)
let dataDir;   // LLMIDE_DATA_DIR target
let writers = []; // connections kept open so the legacy DB has un-checkpointed WAL rows

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const env = (extra = {}) => ({ LLMIDE_DATA_DIR: dataDir, ...extra });

function makeLegacy({ withAgent = true, withTrees = true } = {}) {
  const kb = path.join(root, 'kb');
  fs.mkdirSync(kb, { recursive: true });
  const db = new Database(path.join(kb, 'data.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0'); // keep the rows in the -wal file
  db.exec('CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE users (id TEXT);');
  const ins = db.prepare('INSERT INTO meetings (title) VALUES (?)');
  for (let i = 0; i < 25; i++) ins.run(`m${i}`);
  db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
  writers.push(db);
  if (withAgent) {
    const a = new Database(path.join(kb, 'agent.db'));
    a.pragma('journal_mode = WAL');
    a.exec('CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, outcome TEXT)');
    a.prepare('INSERT INTO agent_runs (outcome) VALUES (?)').run('ok');
    a.close();
  }
  if (withTrees) {
    fs.mkdirSync(path.join(kb, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(kb, 'backups', 'data-1.db'), 'backup-bytes');
    fs.mkdirSync(path.join(kb, 'agent-sdk', 'u1'), { recursive: true });
    fs.writeFileSync(path.join(kb, 'agent-sdk', 'u1', 'cred.json'), '{}');
  }
  return kb;
}

function legacyFiles(kb) {
  return ['data.db', 'data.db-wal', 'agent.db', 'agent.db-wal']
    .map((n) => path.join(kb, n)).filter((f) => fs.existsSync(f));
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-migr-'));
  root = path.join(work, 'repo');
  dataDir = path.join(work, 'system');
  writers = [];
  clearDataDirOverride();
});

afterEach(() => {
  for (const w of writers) { try { w.close(); } catch { /* already closed */ } }
  fs.rmSync(work, { recursive: true, force: true });
  clearDataDirOverride();
});

test('migrates a WAL DB with its rows, agent.db, backups and agent-sdk; legacy untouched', () => {
  const kb = makeLegacy();
  const before = legacyFiles(kb).map((f) => [f, sha(f)]);
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  assert.equal(report.tables.meetings, 25);
  assert.equal(report.tables.users, 1);

  // Rows that only existed in the WAL made it into the copy.
  const copy = new Database(path.join(dataDir, 'data.db'), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM meetings').get().n, 25);
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  copy.close();

  const agent = new Database(path.join(dataDir, 'agent.db'), { readonly: true });
  assert.equal(agent.prepare('SELECT COUNT(*) n FROM agent_runs').get().n, 1);
  agent.close();

  assert.equal(fs.readFileSync(path.join(dataDir, 'backups', 'data-1.db'), 'utf8'), 'backup-bytes');
  assert.ok(fs.existsSync(path.join(dataDir, 'agent-sdk', 'u1', 'cred.json')));
  const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'migrated-from.json'), 'utf8'));
  assert.equal(marker.source, path.join(kb, 'data.db'));
  assert.equal(marker.tables.meetings, 25);
  assert.ok(marker.migratedAt);

  // The legacy files are byte-identical (the writer above is still open, so no checkpoint ran).
  for (const [f, digest] of before) assert.equal(sha(f), digest, `${f} changed`);
  assert.equal(getDataDirOverride(), undefined, 'success leaves the env-chosen dir in place');
  assert.equal(getDataMigrationReport().status, 'migrated');
  assert.equal(fs.existsSync(path.join(dataDir, '.migrating')), false);
});

test('idempotent: a second run skips because data.db already exists', () => {
  makeLegacy();
  runDataDirMigration({ env: env(), root });
  const again = runDataDirMigration({ env: env(), root });
  assert.equal(again.status, 'skipped');
  assert.equal(again.reason, 'data-dir-has-db');
  assert.equal(getDataDirOverride(), undefined);
});

test('partial failure: copy removed, legacy kept, server falls back for this run', () => {
  const kb = makeLegacy();
  const report = runDataDirMigration({
    env: env(), root,
    fault: (step) => { if (step === 'commit:data.db') throw new Error('disk full (injected)'); },
  });
  assert.equal(report.status, 'fallback');
  assert.equal(report.reason, 'copy-failed');
  assert.match(report.notes.join(' '), /disk full/);
  assert.equal(getDataDirOverride(), null, 'config must read the legacy location');
  // Nothing half-copied survives in the data dir.
  for (const name of ['data.db', 'agent.db', 'backups', 'agent-sdk', 'migrated-from.json', '.migrating']) {
    assert.equal(fs.existsSync(path.join(dataDir, name)), false, `${name} left behind`);
  }
  assert.ok(fs.existsSync(path.join(kb, 'data.db')), 'legacy DB kept');
});

test('partial failure at the agent.db step also cleans up and falls back', () => {
  makeLegacy();
  const report = runDataDirMigration({
    env: env(), root,
    fault: (step) => { if (step === 'backups') throw new Error('injected'); },
  });
  assert.equal(report.status, 'fallback');
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'agent.db')), false);
});

test('refuses while another process holds the legacy DB, and falls back', () => {
  const kb = makeLegacy();
  // Another writer holds the write lock (a live server).
  const holder = new Database(path.join(kb, 'data.db'));
  holder.prepare('BEGIN IMMEDIATE').run();
  writers.push(holder);
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'fallback', JSON.stringify(report));
  assert.match(report.notes.join(' '), /in use by another process/);
  assert.equal(getDataDirOverride(), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  holder.prepare('ROLLBACK').run();
});

test('skips when there is no legacy DB (fresh install) and creates the dir 0700', () => {
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'no-legacy-db');
  assert.equal(getDataDirOverride(), undefined);
  assert.ok(fs.statSync(dataDir).isDirectory());
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

test('skips when LLMIDE_DATA_DIR is unset', () => {
  makeLegacy();
  const report = runDataDirMigration({ env: {}, root });
  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'no-data-dir');
  assert.equal(fs.existsSync(dataDir), false);
});

test('skips under the test runner, and when LLMIDE_DB_PATH pins the DB', () => {
  makeLegacy();
  assert.equal(runDataDirMigration({ env: env({ NODE_TEST_CONTEXT: '1' }), root }).reason, 'test-run');
  assert.equal(runDataDirMigration({ env: env({ LLMIDE_DB_PATH: '/x/y.db' }), root }).reason, 'db-path-overridden');
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
});

test('a legacy kb with no agent.db or trees still migrates the DB', () => {
  makeLegacy({ withAgent: false, withTrees: false });
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated');
  assert.equal(fs.existsSync(path.join(dataDir, 'agent.db')), false);
  assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
});
