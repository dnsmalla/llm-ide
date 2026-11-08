// One-time IMPORT of the old Mac app's data dir into the desktop core data dir
// (kb/legacy-import.mjs). Temp dirs only: never a real ~/Library/Application Support.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  runLegacyImport, legacyImportStatus, MARKER, JOURNAL, STAGING, REPLACED,
} from '../kb/legacy-import.mjs';

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kb', 'legacy-import.mjs');
let work;
let legacyDir;
let targetDir;
let holders = [];

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-import-'));
  legacyDir = path.join(work, 'legacy-system');
  targetDir = path.join(work, 'desktop-core');
  holders = [];
});

afterEach(() => {
  for (const h of holders) { try { if (h.open) h.close(); } catch { /* closed */ } }
  holders = [];
  fs.rmSync(work, { recursive: true, force: true });
});

function open(file, opts = {}) {
  const db = new Database(file, { fileMustExist: true, ...opts });
  holders.push(db);
  return db;
}

function makeLegacy({ walRows = false, vaultRows = false, agent = true, secrets = true, migrations = 69 } = {}) {
  fs.mkdirSync(legacyDir, { recursive: true, mode: 0o700 });
  const file = path.join(legacyDir, 'data.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE meetings (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
  `);
  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migrations, 'test');
  db.prepare('INSERT INTO users (id) VALUES (?)').run('mac-user');
  for (let i = 0; i < 25; i++) db.prepare('INSERT INTO meetings (title) VALUES (?)').run(`mac-meeting-${i}`);
  if (vaultRows) {
    db.exec('CREATE TABLE user_secrets (user_id TEXT, key TEXT, blob BLOB)');
    db.prepare('INSERT INTO user_secrets VALUES (?, ?, ?)').run('mac-user', 'claude.apiKey', crypto.randomBytes(16));
  }
  if (walRows) {
    // Keep WAL-resident rows in a directory with no live connection: copy the DB and
    // its WAL aside while open, close (which checkpoints the originals), then restore
    // the copied pair. This is the state a crash leaves behind.
    const stash = path.join(work, `stash-${crypto.randomUUID()}`);
    fs.mkdirSync(stash);
    fs.copyFileSync(file, path.join(stash, 'data.db'));
    fs.copyFileSync(`${file}-wal`, path.join(stash, 'data.db-wal'));
    db.close();
    fs.copyFileSync(path.join(stash, 'data.db'), file);
    fs.copyFileSync(path.join(stash, 'data.db-wal'), `${file}-wal`);
    fs.rmSync(`${file}-shm`, { force: true });
  } else {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }
  if (agent) {
    const a = new Database(path.join(legacyDir, 'agent.db'));
    a.pragma('journal_mode = WAL');
    a.exec('CREATE TABLE agent_schema_migrations (version INTEGER PRIMARY KEY, name TEXT); CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, outcome TEXT);');
    a.prepare('INSERT INTO agent_schema_migrations (version, name) VALUES (?, ?)').run(12, 'test');
    a.prepare("INSERT INTO agent_runs (outcome) VALUES ('ok')").run();
    a.pragma('wal_checkpoint(TRUNCATE)');
    a.close();
  }
  if (secrets) {
    fs.writeFileSync(path.join(legacyDir, '.dev-secrets.json'), JSON.stringify({ jwtSecret: 'j'.repeat(64), vaultKey: 'K'.repeat(64) }, null, 2), { mode: 0o600 });
  }
  // Things the import deliberately does not take.
  fs.mkdirSync(path.join(legacyDir, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'backups', 'data-1.db'), 'old-backup');
  fs.mkdirSync(path.join(legacyDir, 'agent-sdk', 'mac-user'), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'agent-sdk', 'mac-user', 'cred.json'), '{}');
}

function makeTarget() {
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const file = path.join(targetDir, 'data.db');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT, checksum TEXT); CREATE TABLE users (id TEXT PRIMARY KEY); CREATE TABLE desktop_only (id INTEGER PRIMARY KEY, note TEXT);');
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (1, 'desktop')").run();
  db.prepare("INSERT INTO users (id) VALUES ('desktop-user')").run();
  db.prepare("INSERT INTO desktop_only (note) VALUES ('keep me')").run();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const a = new Database(path.join(targetDir, 'agent.db'));
  a.exec('CREATE TABLE agent_schema_migrations (version INTEGER PRIMARY KEY, name TEXT); CREATE TABLE agent_runs (id INTEGER PRIMARY KEY, outcome TEXT);');
  a.prepare('INSERT INTO agent_schema_migrations (version, name) VALUES (3, ?)').run('desktop');
  a.prepare("INSERT INTO agent_runs (outcome) VALUES ('desktop-run')").run();
  a.close();
  fs.writeFileSync(path.join(targetDir, '.dev-secrets.json'), JSON.stringify({ jwtSecret: 'd'.repeat(64), vaultKey: 'D'.repeat(64) }), { mode: 0o600 });
}

function tree(dir) {
  const out = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      const rel = path.relative(dir, p);
      if (ent.isDirectory()) { out[`${rel}/`] = 'dir'; walk(p); }
      else if (ent.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      else out[rel] = 'other';
    }
  };
  walk(dir);
  return out;
}

function count(file, sql) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare(sql).get().n; } finally { db.close(); }
}

function migration(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try { return db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v; } finally { db.close(); }
}

test('imports a valid legacy dir, verifies it, writes the marker, and leaves the legacy untouched', () => {
  makeLegacy({ vaultRows: true });
  const before = tree(legacyDir);
  const report = runLegacyImport({ legacyDir, targetDir });
  assert.equal(report.status, 'completed', JSON.stringify(report));
  assert.equal(report.tables.meetings, 25);
  assert.equal(report.migration, 69);
  assert.equal(report.agentMigration, 12);
  assert.equal(report.secretsImported, true);
  assert.equal(report.backups.length, 0);

  assert.equal(count(path.join(targetDir, 'data.db'), 'SELECT COUNT(*) AS n FROM meetings'), 25);
  assert.equal(count(path.join(targetDir, 'data.db'), "SELECT COUNT(*) AS n FROM users WHERE id = 'mac-user'"), 1);
  assert.equal(count(path.join(targetDir, 'data.db'), 'SELECT COUNT(*) AS n FROM user_secrets'), 1);
  assert.equal(migration(path.join(targetDir, 'data.db')), 69);
  assert.equal(count(path.join(targetDir, 'agent.db'), 'SELECT COUNT(*) AS n FROM agent_runs'), 1);
  assert.equal(
    fs.readFileSync(path.join(targetDir, '.dev-secrets.json'), 'utf8'),
    fs.readFileSync(path.join(legacyDir, '.dev-secrets.json'), 'utf8'),
  );
  const marker = JSON.parse(fs.readFileSync(path.join(targetDir, MARKER), 'utf8'));
  assert.equal(marker.status, 'completed');
  assert.equal(marker.tables.meetings, 25);
  assert.equal(marker.replaced, false);
  for (const gone of [STAGING, REPLACED, JOURNAL, '.legacy-import.lock']) {
    assert.equal(fs.existsSync(path.join(targetDir, gone)), false, `${gone} should be cleaned up`);
  }
  // Not imported, still in the old folder.
  assert.equal(fs.existsSync(path.join(targetDir, 'backups')), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'agent-sdk')), false);
  assert.deepEqual(tree(legacyDir), before, 'the old folder is byte-for-byte untouched');
  assert.equal(legacyImportStatus({ legacyDir, targetDir }).action, 'noop');
});

test('second run is a no-op and changes no byte', () => {
  makeLegacy();
  assert.equal(runLegacyImport({ legacyDir, targetDir }).status, 'completed');
  const before = tree(targetDir);
  const again = runLegacyImport({ legacyDir, targetDir });
  assert.equal(again.status, 'noop');
  assert.equal(again.ran, false);
  assert.deepEqual(tree(targetDir), before);
});

test('a non-empty destination refuses without force and stays untouched', () => {
  makeLegacy();
  makeTarget();
  const targetBefore = tree(targetDir);
  const legacyBefore = tree(legacyDir);
  const status = legacyImportStatus({ legacyDir, targetDir });
  assert.equal(status.action, 'force');
  assert.equal(status.needsForce, true);
  const report = runLegacyImport({ legacyDir, targetDir });
  assert.equal(report.status, 'refused');
  assert.equal(report.reason, 'destination-not-empty');
  assert.equal(report.needsForce, true);
  assert.deepEqual(tree(targetDir), targetBefore);
  assert.deepEqual(tree(legacyDir), legacyBefore);
  assert.equal(fs.existsSync(path.join(targetDir, MARKER)), false);
});

test('force replaces after a verified backup of the desktop DB, agent.db and secrets', () => {
  makeLegacy();
  makeTarget();
  const report = runLegacyImport({ legacyDir, targetDir, force: true });
  assert.equal(report.status, 'completed', JSON.stringify(report));
  assert.equal(report.replaced, true);
  assert.ok(report.backup, 'a backup path is reported');
  const backupDb = path.join(targetDir, report.backup);
  assert.equal(count(backupDb, 'SELECT COUNT(*) AS n FROM desktop_only'), 1, 'the old desktop row is in the backup');
  assert.equal(count(path.join(targetDir, 'data.db'), "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'desktop_only'"), 0, 'the desktop DB was replaced');
  assert.equal(count(path.join(targetDir, 'data.db'), 'SELECT COUNT(*) AS n FROM meetings'), 25);
  assert.ok(report.backups.some((p) => p.endsWith('.agent.db')));
  assert.ok(report.backups.some((p) => p.endsWith('.dev-secrets.json')));
  const marker = JSON.parse(fs.readFileSync(path.join(targetDir, MARKER), 'utf8'));
  assert.equal(marker.replaced, true);
  assert.equal(marker.backups.length, 3);
});

test('a corrupt legacy DB is refused and nothing is touched', () => {
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'data.db'), crypto.randomBytes(4096));
  makeTarget();
  const targetBefore = tree(targetDir);
  const status = legacyImportStatus({ legacyDir, targetDir });
  assert.equal(status.status, 'invalid-legacy');
  assert.equal(status.action, 'refuse');
  const report = runLegacyImport({ legacyDir, targetDir, force: true });
  assert.equal(report.status, 'refused');
  assert.deepEqual(tree(targetDir), targetBefore);
});

test('WAL-resident rows are imported and the legacy WAL is not checkpointed', () => {
  makeLegacy({ walRows: true });
  assert.ok(fs.existsSync(path.join(legacyDir, 'data.db-wal')), 'the fixture starts with a WAL');
  const before = tree(legacyDir);
  const report = runLegacyImport({ legacyDir, targetDir });
  assert.equal(report.status, 'completed', JSON.stringify(report));
  assert.equal(count(path.join(targetDir, 'data.db'), 'SELECT COUNT(*) AS n FROM meetings'), 25);
  assert.deepEqual(tree(legacyDir), before, 'WAL and main file are unchanged, no sidecar was left behind');
});

test('a failed post-commit verification rolls the desktop folder back to its previous files', () => {
  makeLegacy();
  makeTarget();
  const targetBefore = tree(targetDir);
  const report = runLegacyImport({
    legacyDir, targetDir, force: true,
    fault: (step) => { if (step === 'postcommit') throw new Error('injected verification failure'); },
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.reason, 'import-failed');
  assert.equal(report.rolledBack, true, JSON.stringify(report.notes));
  // The live files are exactly as before; the verified backup written before the
  // attempt stays behind as the safety net (it is not a change to the DB).
  const main = (t) => ({ data: t['data.db'], agent: t['agent.db'], secrets: t['.dev-secrets.json'] });
  assert.deepEqual(main(tree(targetDir)), main(targetBefore), 'the desktop DB, agent.db and secrets are exactly as before');
  assert.ok(fs.existsSync(path.join(targetDir, 'backups')));
  for (const gone of [MARKER, JOURNAL, STAGING, REPLACED]) {
    assert.equal(fs.existsSync(path.join(targetDir, gone)), false, `${gone} should be cleaned up`);
  }
});

test('a failure while snapshotting the source never touches the destination', () => {
  makeLegacy();
  makeTarget();
  const targetBefore = tree(targetDir);
  const report = runLegacyImport({
    legacyDir, targetDir, force: true,
    fault: (step) => { if (step === 'snapshot-data') throw new Error('injected snapshot failure'); },
  });
  assert.equal(report.status, 'failed');
  assert.deepEqual(tree(targetDir), targetBefore);
});

test('a destination held by a writer (a running core) is refused', () => {
  makeLegacy();
  makeTarget();
  const targetBefore = tree(targetDir);
  const held = open(path.join(targetDir, 'data.db'), { timeout: 0 });
  held.exec('BEGIN IMMEDIATE');
  try {
    const report = runLegacyImport({ legacyDir, targetDir, force: true });
    assert.equal(report.status, 'refused');
    assert.equal(report.reason, 'target-in-use');
  } finally {
    held.exec('ROLLBACK');
  }
  // The held connection's own WAL sidecars exist because the test opened it; compare
  // the real files, not those transient sidecars.
  const main = (t) => ({ data: t['data.db'], agent: t['agent.db'], secrets: t['.dev-secrets.json'] });
  assert.deepEqual(main(tree(targetDir)), main(targetBefore));
});

test('a completed marker without a healthy target refuses instead of importing again', () => {
  makeLegacy();
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, MARKER), JSON.stringify({ formatVersion: 1, status: 'completed', importedAt: '2026-01-01T00:00:00.000Z', backups: [] }));
  const report = runLegacyImport({ legacyDir, targetDir, force: true });
  assert.equal(report.status, 'refused');
  assert.equal(report.reason, 'marker-without-valid-db');
  assert.equal(fs.existsSync(path.join(targetDir, 'data.db')), false);
});

test('vault rows without the old vault key are refused', () => {
  makeLegacy({ vaultRows: true, secrets: false });
  const report = runLegacyImport({ legacyDir, targetDir });
  assert.equal(report.status, 'refused');
  assert.equal(report.reason, 'legacy-vault-key-missing');
  assert.equal(fs.existsSync(path.join(targetDir, 'data.db')), false);
});

test('no free space is refused before anything is written', () => {
  makeLegacy();
  const report = runLegacyImport({ legacyDir, targetDir, freeBytes: () => 0 });
  assert.equal(report.status, 'refused');
  assert.equal(report.reason, 'no-space');
  assert.equal(fs.existsSync(path.join(targetDir, 'data.db')), false);
  assert.equal(fs.existsSync(path.join(targetDir, STAGING)), false);
});

test('the CLI prints one JSON report and exits 0 for a verified import', () => {
  makeLegacy();
  const out = execFileSync(process.execPath, [MODULE, '--import', '--json', '--legacy', legacyDir, '--target', targetDir], { encoding: 'utf8' });
  const report = JSON.parse(out);
  assert.equal(report.status, 'completed');
  assert.equal(report.tables.meetings, 25);
  const status = JSON.parse(execFileSync(process.execPath, [MODULE, '--status', '--json', '--legacy', legacyDir, '--target', targetDir], { encoding: 'utf8' }));
  assert.equal(status.action, 'noop');
});
