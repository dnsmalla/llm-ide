// One-time MOVE of <repo>/kb into LLMIDE_DATA_DIR (kb/data-dir-migration.mjs).
// Temp dirs only: never the real kb/.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { runDataDirMigration } from '../kb/data-dir-migration.mjs';
import { getDataDirOverride, clearDataDirOverride, getDataMigrationReport } from '../core/data-dir.mjs';

let work;
let root;      // fake repo root (holds kb/)
let dataDir;   // LLMIDE_DATA_DIR target
let holders = []; // test-owned connections, closed in afterEach

const env = (extra = {}) => ({ LLMIDE_DATA_DIR: dataDir, ...extra });
const kbOf = () => path.join(root, 'kb');
const exists = (...p) => fs.existsSync(path.join(...p));

// A legacy kb whose newest rows are still in the WAL, as on a live server.
// Closing the last connection would checkpoint them, so the -wal (and main file)
// are copied aside while open, then restored after close: the same WAL-resident
// state, with no connection left open.
function makeLegacy({ withAgent = true, withTrees = true, vaultRows = false } = {}) {
  const kb = kbOf();
  fs.mkdirSync(kb, { recursive: true });
  const dbFile = path.join(kb, 'data.db');
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE meetings (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE users (id TEXT);');
  const ins = db.prepare('INSERT INTO meetings (title) VALUES (?)');
  for (let i = 0; i < 25; i++) ins.run(`m${i}`);
  db.prepare('INSERT INTO users (id) VALUES (?)').run('u1');
  if (vaultRows) {
    db.exec('CREATE TABLE user_secrets (user_id TEXT, key TEXT, blob BLOB)');
    db.prepare('INSERT INTO user_secrets VALUES (?, ?, ?)').run('u1', 'claude.apiKey', Buffer.from('x'));
  }
  const stash = path.join(work, `stash-${crypto.randomUUID()}`);
  fs.mkdirSync(stash);
  fs.copyFileSync(dbFile, path.join(stash, 'data.db'));
  fs.copyFileSync(`${dbFile}-wal`, path.join(stash, 'data.db-wal'));
  db.close();
  fs.copyFileSync(path.join(stash, 'data.db'), dbFile);
  fs.copyFileSync(path.join(stash, 'data.db-wal'), `${dbFile}-wal`);
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

function writeLegacySecrets(kb, vaultKey) {
  fs.writeFileSync(path.join(kb, '.dev-secrets.json'),
    JSON.stringify({ jwtSecret: 'j'.repeat(64), vaultKey }, null, 2), { mode: 0o600 });
}

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-migr-'));
  root = path.join(work, 'repo');
  dataDir = path.join(work, 'system');
  holders = [];
  clearDataDirOverride();
});

afterEach(() => {
  for (const h of holders) { try { if (h.open) h.close(); } catch { /* closed */ } }
  fs.rmSync(work, { recursive: true, force: true });
  clearDataDirOverride();
});

test('moves the DB with its WAL rows, agent.db, agent-sdk and secrets; deletes the legacy copies; leaves backups', () => {
  const kb = makeLegacy();
  writeLegacySecrets(kb, 'K'.repeat(64));
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  assert.equal(report.tables.meetings, 25);

  // Rows that only existed in the WAL made it into the new DB.
  const copy = new Database(path.join(dataDir, 'data.db'), { readonly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 25);
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  copy.close();
  const agent = new Database(path.join(dataDir, 'agent.db'), { readonly: true });
  assert.equal(agent.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1);
  agent.close();
  assert.ok(fs.existsSync(path.join(dataDir, 'agent-sdk', 'u1', 'cred.json')));

  // The legacy copies are gone (the move deletes them after verification).
  for (const f of ['data.db', 'data.db-wal', 'data.db-shm', 'agent.db', 'agent.db-wal', 'agent.db-shm', '.dev-secrets.json']) {
    assert.equal(exists(kb, f), false, `${f} should have been moved away`);
  }
  assert.equal(exists(kb, 'agent-sdk'), false);
  // backups/ is neither copied nor deleted.
  assert.equal(exists(dataDir, 'backups'), false);
  assert.equal(fs.readFileSync(path.join(kb, 'backups', 'data-1.db'), 'utf8'), 'backup-bytes');

  const marker = JSON.parse(fs.readFileSync(path.join(dataDir, 'migrated-from.json'), 'utf8'));
  assert.equal(marker.tables.meetings, 25);
  assert.equal(marker.backups, false);
  assert.equal(marker.legacyBaseline, undefined, 'no baseline: the legacy copies are gone');
  assert.ok(report.removedLegacy.includes('data.db'));

  const notice = fs.readFileSync(path.join(kb, 'MOVED-TO-APP-SUPPORT.txt'), 'utf8');
  assert.match(notice, /MOVED/);
  assert.match(notice, /Rollback is NOT automatic/);
  assert.match(notice, /Now lives:\s+.*system/);

  assert.equal(getDataDirOverride(), undefined, 'success leaves the env-chosen dir in place');
  assert.equal(getDataMigrationReport().status, 'migrated');
  assert.equal(fs.existsSync(path.join(dataDir, '.migrating')), false);
  assert.equal(fs.existsSync(path.join(dataDir, '.migrating-owner')), false);
});

test('idempotent: a second run skips because data.db already exists, and reports no fork', () => {
  makeLegacy({ withAgent: false, withTrees: false });
  runDataDirMigration({ env: env(), root });
  const again = runDataDirMigration({ env: env(), root });
  assert.equal(again.status, 'skipped');
  assert.equal(again.reason, 'data-dir-has-db');
  assert.equal(again.legacyDiverged, false);
  assert.equal(getDataDirOverride(), undefined);
});

test('a failed commit rolls back, falls back, and keeps every legacy file', () => {
  const kb = makeLegacy();
  const report = runDataDirMigration({
    env: env(), root,
    fault: (step) => { if (step === 'commit:data.db') throw new Error('disk full (injected)'); },
  });
  assert.equal(report.status, 'fallback');
  assert.equal(report.reason, 'copy-failed');
  assert.match(report.notes.join(' '), /disk full/);
  assert.equal(getDataDirOverride(), null, 'config must read the legacy location');
  for (const name of ['data.db', 'agent.db', 'backups', 'agent-sdk', 'migrated-from.json', '.migrating', '.migrating-owner']) {
    assert.equal(fs.existsSync(path.join(dataDir, name)), false, `${name} left behind`);
  }
  assert.ok(exists(kb, 'data.db') && exists(kb, 'agent.db') && exists(kb, 'agent-sdk'), 'legacy files kept');
});

test('a failed verification deletes nothing', () => {
  const kb = makeLegacy();
  writeLegacySecrets(kb, 'K'.repeat(64));
  const report = runDataDirMigration({
    env: env(), root,
    fault: (step) => { if (step === 'verify') throw new Error('row count mismatch (injected)'); },
  });
  assert.equal(report.status, 'fallback');
  assert.ok(exists(kb, 'data.db') && exists(kb, 'agent.db') && exists(kb, '.dev-secrets.json'));
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
});

test('a failed post-commit check rolls the commit back and keeps the legacy files', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  const report = runDataDirMigration({
    env: env(), root,
    fault: (step) => { if (step === 'postcommit') throw new Error('post-commit check failed (injected)'); },
  });
  assert.equal(report.status, 'fallback');
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false, 'the committed copy must be removed');
  assert.ok(exists(kb, 'data.db'));
});

test('a failure while deleting leaves the verified new copy and says what remains', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  const report = runDataDirMigration({
    env: env(), root,
    fault: (step) => { if (step === 'delete:wal') throw new Error('EBUSY (injected)'); },
  });
  assert.equal(report.status, 'migrated');
  assert.match(report.notes.join(' '), /legacy removal incomplete/);
  assert.ok(fs.existsSync(path.join(dataDir, 'data.db')));
  assert.ok(exists(kb, 'data.db'), 'nothing was deleted before the failure');
});

test('refuses while an IDLE server connection holds the legacy DB, and keeps everything', () => {
  const kb = makeLegacy();
  const idle = new Database(path.join(kb, 'data.db'));
  idle.prepare('SELECT COUNT(*) AS n FROM meetings').get();
  holders.push(idle);
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'fallback', JSON.stringify(report));
  assert.equal(report.reason, 'legacy-in-use');
  assert.match(report.notes.join(' '), /in use by another process/);
  assert.equal(getDataDirOverride(), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  assert.ok(exists(kb, 'data.db') && exists(kb, 'agent.db'));
  assert.equal(idle.prepare('SELECT COUNT(*) AS n FROM meetings').get().n, 25);
});

test('refuses while a write transaction holds the legacy DB, and keeps everything', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  const holder = new Database(path.join(kb, 'data.db'));
  holder.prepare('BEGIN IMMEDIATE').run();
  holders.push(holder);
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'fallback');
  assert.equal(report.reason, 'legacy-in-use');
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  assert.ok(exists(kb, 'data.db'));
  holder.prepare('ROLLBACK').run();
});

test('skips when there is no legacy DB (fresh install) and creates the dir 0700', () => {
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'skipped');
  assert.equal(report.reason, 'no-legacy-db');
  assert.equal(getDataDirOverride(), undefined);
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
});

test('skips when LLMIDE_DATA_DIR is unset', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  const report = runDataDirMigration({ env: {}, root });
  assert.equal(report.reason, 'no-data-dir');
  assert.ok(exists(kb, 'data.db'));
});

test('under the test runner nothing is moved or deleted; LLMIDE_DB_PATH pins the DB', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  assert.equal(runDataDirMigration({ env: env({ NODE_TEST_CONTEXT: '1' }), root }).reason, 'test-run');
  assert.equal(runDataDirMigration({ env: env({ LLMIDE_DB_PATH: '/x/y.db' }), root }).reason, 'db-path-overridden');
  assert.ok(exists(kb, 'data.db'), 'the legacy DB is never deleted under the test runner');
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
});

test('agent-sdk/ over the cap stays in the legacy kb with a note; the DB still moves', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: true });
  const report = runDataDirMigration({ env: env(), root, sdkCapBytes: 1 });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  assert.equal(fs.existsSync(path.join(dataDir, 'agent-sdk')), false);
  assert.match(report.healthNotes.join(' '), /agent-sdk\/ not moved/);
  assert.ok(exists(kb, 'agent-sdk', 'u1', 'cred.json'));
});

test('an agent.db already in the data dir is not overwritten, and the legacy one stays', () => {
  const kb = makeLegacy();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agent.db'), 'someone else put this here');
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  assert.match(report.notes.join(' '), /agent\.db not moved/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'agent.db'), 'utf8'), 'someone else put this here');
  assert.ok(exists(kb, 'agent.db'));
});

// --- dev secrets (the vault key) ---------------------------------------------

const VAULT_URL = new URL('../server/vault.mjs', import.meta.url).href;
const KEY_A = 'A'.repeat(64);
const KEY_B = 'B'.repeat(64);

// Encrypt/decrypt through the real server/vault.mjs in a child process, so the
// key comes from its env exactly as in production.
function vaultOp(key, op, arg) {
  const child = path.join(work, `vault-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(child, `const v = await import(${JSON.stringify(VAULT_URL)});
const { op, user, arg } = JSON.parse(process.env.VAULT_ARGS);
if (op === 'enc') process.stdout.write(v.encrypt(user, arg).toString('base64'));
else process.stdout.write(v.decrypt(user, Buffer.from(arg, 'base64')));
`);
  return execFileSync(process.execPath, [child], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NODE_TEST_CONTEXT: '1',
      LLMIDE_JWT_SECRET: 'j'.repeat(64),
      LLMIDE_VAULT_KEY: key,
      VAULT_ARGS: JSON.stringify({ op, user: 'user-1', arg }),
    },
  });
}

test('the dev secrets file is copied byte-identical with mode 0600, then the legacy one is deleted', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  writeLegacySecrets(kb, KEY_A);
  const before = fs.readFileSync(path.join(kb, '.dev-secrets.json'), 'utf8');
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  const dst = path.join(dataDir, '.dev-secrets.json');
  assert.equal(fs.readFileSync(dst, 'utf8'), before);
  assert.equal(fs.statSync(dst).mode & 0o777, 0o600);
  assert.equal(exists(kb, '.dev-secrets.json'), false);
});

test('a vault-encrypted value decrypts after the move with the copied key', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  writeLegacySecrets(kb, KEY_A);
  const blob = vaultOp(KEY_A, 'enc', 'sk-ant-test-secret');
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  const copied = JSON.parse(fs.readFileSync(path.join(dataDir, '.dev-secrets.json'), 'utf8'));
  assert.equal(copied.vaultKey, KEY_A);
  assert.equal(vaultOp(copied.vaultKey, 'dec', blob), 'sk-ant-test-secret');
  assert.throws(() => vaultOp(KEY_B, 'dec', blob), 'a different key must not decrypt it');
});

test('a legacy vault with stored secrets but no key file falls back instead of moving', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false, vaultRows: true });
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'fallback', JSON.stringify(report));
  assert.match(report.notes.join(' '), /key file is missing/);
  assert.equal(getDataDirOverride(), null);
  assert.equal(fs.existsSync(path.join(dataDir, 'data.db')), false);
  assert.ok(exists(kb, 'data.db'));
});

// --- a legacy DB recreated after the move ------------------------------------

test('a legacy data.db that exists again after the move is reported as divergence', () => {
  const kb = makeLegacy({ withAgent: false, withTrees: false });
  runDataDirMigration({ env: env(), root });
  assert.equal(runDataDirMigration({ env: env(), root }).legacyDiverged, false);
  // An older server started on the repo kb creates a fresh, empty data.db.
  new Database(path.join(kb, 'data.db')).close();
  const again = runDataDirMigration({ env: env(), root });
  assert.equal(again.status, 'skipped');
  assert.equal(again.legacyDiverged, true);
});

test('no marker means divergence is unknown, not reported', () => {
  makeLegacy({ withAgent: false, withTrees: false });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'data.db'), 'placeholder');
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'skipped');
  assert.equal(report.legacyDiverged, null);
});

// --- an interrupted run (a crash between renames) ------------------------------

test('a retry discards an agent.db left by an interrupted run, and moves a fresh one', () => {
  makeLegacy();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'agent.db'), 'stale partial copy');
  fs.writeFileSync(path.join(dataDir, '.migrating-owner'), JSON.stringify({ owns: ['data.db', 'agent.db'] }));
  const report = runDataDirMigration({ env: env(), root });
  assert.equal(report.status, 'migrated', JSON.stringify(report));
  const agent = new Database(path.join(dataDir, 'agent.db'), { readonly: true });
  assert.equal(agent.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1, 'the stale file must not survive');
  agent.close();
  assert.equal(fs.existsSync(path.join(dataDir, '.migrating-owner')), false);
});
