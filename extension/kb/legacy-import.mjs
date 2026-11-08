// One-time, verified IMPORT of the retired Mac app's data directory into this app's
// desktop data directory.
//
//   source: ~/Library/Application Support/llm-ide/system      (the old Mac app)
//   target: ~/Library/Application Support/llm-ide-desktop/core (the Tauri desktop)
//
// This is deliberately NOT the repo-kb -> data-dir MOVE in `data-dir-migration.mjs`:
// that move relocates a checkout's own kb data; this copies another application's
// data into a live desktop install. The two share the verified-copy ideas (SQLite
// snapshot, integrity check, row-count fingerprint, sqlite_sequence, atomic marker)
// but nothing else. In particular the legacy folder is never renamed, deleted or
// checkpointed: it is read under a write lock and sidecar files this run created are
// removed again.
//
// Guarantees
//   - Detection only: a legacy folder counts only when `<dir>/data.db` exists, is a
//     real SQLite database, passes quick_check, has tables and a schema_migrations
//     version. The target counts as empty/initial when it has no data.db, a zero-byte
//     one, or one with no tables.
//   - Explicit: a non-empty target needs `force` from a surface that first asked the
//     user (the desktop host shows a native, Cancel-first dialog; the CLI needs
//     --force). A backup is written and verified BEFORE anything is replaced.
//   - Quiescent: the source and the target are opened with `BEGIN IMMEDIATE` so a
//     writer makes the import refuse instead of copying a torn database. Snapshots use
//     VACUUM INTO (WAL rows included) and never checkpoint the legacy WAL.
//   - Verified before switching: integrity_check on every copy, per-table row counts
//     and sqlite_sequence against the locked source, schema_migrations version, then
//     the same checks again on the committed files.
//   - Rollback: the new files are staged; the old target files are moved aside, not
//     deleted, and the switch happens by rename with data.db last. Any failure removes
//     the new files and puts the old ones back. The target is untouched on a refusal.
//   - Once: a completed `legacy-import.json` marker plus a healthy target makes every
//     later run a no-op. A marker without a healthy target, or a journal from an
//     interrupted run, refuses instead of importing again.
//
// Agent-sdk/ and backups/ are not imported (reported in notes): the first holds
// per-user Claude logins, the second is old copies. `.dev-secrets.json` IS imported
// when present, because it holds the vault master key; the desktop host additionally
// moves those two values into the OS keychain it passes to the core.
//
// The module has no boot side effects and is also the CLI used by the desktop host:
//   node extension/kb/legacy-import.mjs --status
//   node extension/kb/legacy-import.mjs --import --force

import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Database from 'better-sqlite3';

export const FORMAT_VERSION = 1;
export const MARKER = 'legacy-import.json';
export const JOURNAL = 'legacy-import.journal.json';
export const STAGING = '.legacy-import';
export const REPLACED = '.legacy-import-replaced';
export const LOCK = '.legacy-import.lock';
const BACKUP_PREFIX = 'pre-import-';
const MAIN_MIGRATIONS = 'schema_migrations';
const AGENT_MIGRATIONS = 'agent_schema_migrations';
const SECRETS = '.dev-secrets.json';
const MIN_SECRET_LEN = 32;
const LOCK_WAIT_MS = 10_000;
const FREE_SPACE_MARGIN = 16 * 1024 ** 2;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const defaultFreeBytes = (dir) => {
  const s = fs.statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The old Mac app's data directory for this machine, or null off macOS. */
export function defaultLegacyDir(env = process.env, platform = process.platform) {
  const override = str(env.LLMIDE_LEGACY_DATA_DIR);
  if (override) return path.resolve(override);
  if (platform !== 'darwin') return null;
  const home = str(env.HOME);
  return home ? path.join(home, 'Library', 'Application Support', 'llm-ide', 'system') : null;
}

/** The desktop core data directory (`<app data>/core`), matching fsutil::data_dir_for. */
export function defaultTargetDir(env = process.env, platform = process.platform) {
  const override = str(env.LLMIDE_DESKTOP_DATA_DIR);
  if (override) return path.join(path.resolve(override), 'core');
  if (platform === 'darwin') {
    const home = str(env.HOME);
    return home ? path.join(home, 'Library', 'Application Support', 'llm-ide-desktop', 'core') : null;
  }
  if (platform === 'win32') {
    const base = str(env.LOCALAPPDATA);
    return base ? path.join(base, 'llm-ide-desktop', 'core') : null;
  }
  const xdg = str(env.XDG_DATA_HOME);
  const home = str(env.HOME);
  const base = xdg ? path.resolve(xdg) : (home ? path.join(home, '.local', 'share') : null);
  return base ? path.join(base, 'llm-ide-desktop', 'core') : null;
}

/**
 * Read-only status: what would an import do, and is one already done?
 *
 * @param {{legacyDir?: string|null, targetDir?: string|null}} [opts]
 * @returns {object} a report (`action` is the decision: import | force | refuse | noop | none)
 */
export function legacyImportStatus(opts = {}) {
  const started = Date.now();
  const legacyDir = opts.legacyDir !== undefined ? opts.legacyDir : defaultLegacyDir();
  const targetDir = opts.targetDir !== undefined ? opts.targetDir : defaultTargetDir();
  const report = {
    formatVersion: FORMAT_VERSION,
    status: 'unavailable',
    reason: null,
    action: 'none',
    legacy: emptySide(),
    target: emptySide(),
    marker: null,
    needsForce: false,
    hasVaultSecrets: false,
    notes: [],
    durationMs: 0,
  };
  if (!legacyDir) {
    report.reason = 'no-legacy-dir';
    report.notes.push('The old Mac app data folder only exists on macOS; set LLMIDE_LEGACY_DATA_DIR to point at a copy.');
    return finishStatus(report, started);
  }
  if (!targetDir) {
    report.reason = 'no-target-dir';
    report.notes.push('The desktop data folder could not be resolved; set LLMIDE_DESKTOP_DATA_DIR.');
    return finishStatus(report, started);
  }

  report.legacy = inspectSide(legacyDir, 'data.db');
  report.target = inspectSide(targetDir, 'data.db');
  report.hasVaultSecrets = (report.legacy.tables.user_secrets ?? 0) > 0;

  const marker = readMarker(targetDir);
  report.marker = marker.value;
  if (marker.present && marker.error) {
    report.status = 'refused';
    report.reason = 'marker-unreadable';
    report.action = 'refuse';
    report.notes.push(`The import marker ${MARKER} exists but cannot be read; inspect it by hand. Nothing was changed.`);
    return finishStatus(report, started);
  }
  if (marker.value?.status === 'completed') {
    if (report.target.valid) {
      report.status = 'already-imported';
      report.reason = 'already-imported';
      report.action = 'noop';
      return finishStatus(report, started);
    }
    report.status = 'refused';
    report.reason = 'marker-without-valid-db';
    report.action = 'refuse';
    report.notes.push('The import marker says the data was imported, but the desktop data.db is missing or unreadable. Restore it from the listed backup, or remove the marker by hand after making a backup.');
    return finishStatus(report, started);
  }
  if (fs.existsSync(path.join(targetDir, JOURNAL))) {
    report.status = 'interrupted';
    report.reason = 'interrupted';
    report.action = 'refuse';
    report.notes.push(`An earlier import stopped mid-way (${JOURNAL} is present). Inspect the desktop folder and the backup listed there; nothing was changed.`);
    return finishStatus(report, started);
  }
  if (!report.legacy.exists) {
    report.status = 'unavailable';
    report.reason = 'no-legacy-data';
    return finishStatus(report, started);
  }
  if (!report.legacy.valid) {
    report.status = 'invalid-legacy';
    report.reason = report.legacy.reason;
    report.action = 'refuse';
    report.notes.push(`The old Mac app data.db is not a usable database (${report.legacy.reason}); nothing was changed.`);
    return finishStatus(report, started);
  }
  if (!report.legacy.migration) {
    report.status = 'invalid-legacy';
    report.reason = 'no-schema-migrations';
    report.action = 'refuse';
    report.notes.push('The old Mac app data.db has no applied schema_migrations, so it cannot be the app database.');
    return finishStatus(report, started);
  }
  if (!report.target.exists || report.target.empty) {
    report.status = 'ready';
    report.action = 'import';
    return finishStatus(report, started);
  }
  report.status = 'needs-confirmation';
  report.reason = 'destination-not-empty';
  report.action = 'force';
  report.needsForce = true;
  report.notes.push('The desktop data folder already holds data. Importing replaces it; a verified backup is written first.');
  return finishStatus(report, started);
}

/**
 * Run the one-time import. Refuses (without changing anything) unless the status says
 * `import`, or says `force` and `force` is true.
 *
 * @param {object} opts
 * @param {string|null} [opts.legacyDir]
 * @param {string|null} [opts.targetDir]
 * @param {boolean} [opts.force] the caller confirmed replacing a non-empty target
 * @param {(step: string) => void} [opts.fault] test hook: throws to fail a step
 * @param {number} [opts.now] clock (tests)
 * @param {(dir: string) => number} [opts.freeBytes] free-space probe (tests)
 * @param {(msg: string) => void} [opts.log] progress sink (never receives secrets)
 * @returns {object} the report; `status` is completed | noop | refused | failed | unavailable | interrupted
 */
export function runLegacyImport(opts = {}) {
  const started = Date.now();
  const {
    legacyDir = defaultLegacyDir(), targetDir = defaultTargetDir(), force = false,
    fault = null, now = Date.now(), freeBytes = defaultFreeBytes, log = () => {},
  } = opts;
  const step = (name) => { if (fault) fault(name); };

  const status = legacyImportStatus({ legacyDir, targetDir });
  if (status.action === 'noop') return { ...status, status: 'noop', ran: false, durationMs: Date.now() - started };
  if (status.action === 'none' || status.action === 'refuse') {
    return { ...status, status: status.status === 'interrupted' ? 'interrupted' : (status.status === 'unavailable' ? 'unavailable' : 'refused'), ran: false, durationMs: Date.now() - started };
  }
  if (status.action === 'force' && !force) {
    return { ...status, status: 'refused', reason: 'destination-not-empty', needsForce: true, ran: false, durationMs: Date.now() - started };
  }
  if (!targetDir) return { ...status, status: 'refused', reason: 'no-target-dir', ran: false, durationMs: Date.now() - started };

  const legacyDb = path.join(legacyDir, 'data.db');
  const legacyAgent = path.join(legacyDir, 'agent.db');
  const targetDb = path.join(targetDir, 'data.db');
  const targetAgent = path.join(targetDir, 'agent.db');
  const replacing = status.action === 'force';
  const stamp = uniqueStamp(targetDir, now);
  const report = {
    ...status,
    status: 'failed',
    ran: true,
    startedAt: new Date(now).toISOString(),
    importedAt: null,
    replaced: false,
    backup: null,
    backups: [],
    files: [],
    tables: null,
    totalRows: null,
    migration: null,
    agentMigration: null,
    secretsImported: false,
    notes: [],
  };

  let lock = null;
  let staging = null;
  let replacedDir = null;
  let movedAside = [];
  let committed = [];
  let journalWritten = false;

  try {
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    lock = acquireLock(targetDir);
    staging = path.join(targetDir, STAGING);
    replacedDir = path.join(targetDir, REPLACED);
    removeStrictIfExists(staging);
    removeStrictIfExists(replacedDir);
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.mkdirSync(replacedDir, { mode: 0o700 });

    // Free space before writing anything. Two snapshots (data + agent) and, when
    // replacing, a copy of the old target DB.
    const legacyBytes = fileSize(legacyDb) + fileSize(legacyAgent);
    const targetBytes = replacing ? fileSize(targetDb) + fileSize(targetAgent) : 0;
    const needed = 2 * legacyBytes + targetBytes + FREE_SPACE_MARGIN;
    const free = freeBytes(targetDir);
    if (free < needed) {
      throw fail('no-space', `not enough free space (${mb(free)} MB free, ${mb(needed)} MB needed); nothing was changed`);
    }

    step('lock-target');
    // Refuse while the desktop core still has the target open. This is a lock probe,
    // not a write: it is rolled back immediately.
    assertNotInUse(targetDb, 'target-in-use', 'the desktop data.db is open by another process; stop the desktop core and try again');

    step('snapshot-data');
    log('snapshot data.db');
    const dataCopy = path.join(staging, 'data.db');
    const dataFp = snapshotDatabase(legacyDb, dataCopy);
    report.tables = dataFp.fingerprint.tables;
    report.totalRows = Object.values(dataFp.fingerprint.tables).reduce((a, b) => a + b, 0);
    report.migration = dataFp.migration;

    step('snapshot-agent');
    let agentFp = null;
    if (fs.existsSync(legacyAgent)) {
      log('snapshot agent.db');
      agentFp = snapshotDatabase(legacyAgent, path.join(staging, 'agent.db'));
      report.agentMigration = agentFp.migration;
    } else {
      report.notes.push('No agent.db in the old app; agent run history stays only in the old folder.');
    }

    step('secrets');
    const legacySecrets = path.join(legacyDir, SECRETS);
    let secretsRaw = null;
    if (fs.existsSync(legacySecrets)) {
      const s = readSecrets(legacySecrets);
      secretsRaw = s.raw;
      writePrivate(path.join(staging, SECRETS), s.raw);
      report.secretsImported = true;
    } else if ((dataFp.fingerprint.tables.user_secrets ?? 0) > 0) {
      throw fail('legacy-vault-key-missing', 'the old app has vault-encrypted secrets but no .dev-secrets.json (vault key); refusing to import a vault that cannot be decrypted');
    } else {
      report.notes.push('No .dev-secrets.json in the old app; the desktop vault key stays as it is.');
    }

    // Everything below this point may touch the target. Back up first (verified).
    if (replacing) {
      step('backup');
      log('back up the current desktop data');
      const backupDb = path.join(targetDir, 'backups', `${BACKUP_PREFIX}${stamp}.db`);
      fs.mkdirSync(path.dirname(backupDb), { recursive: true, mode: 0o700 });
      const b = snapshotDatabase(targetDb, backupDb);
      report.backups.push(rel(targetDir, backupDb));
      if (fs.existsSync(targetAgent)) {
        const backupAgent = path.join(targetDir, 'backups', `${BACKUP_PREFIX}${stamp}.agent.db`);
        snapshotDatabase(targetAgent, backupAgent);
        report.backups.push(rel(targetDir, backupAgent));
      }
      if (fs.existsSync(path.join(targetDir, SECRETS))) {
        const backupSecrets = path.join(targetDir, 'backups', `${BACKUP_PREFIX}${stamp}.dev-secrets.json`);
        writePrivate(backupSecrets, fs.readFileSync(path.join(targetDir, SECRETS)));
        report.backups.push(rel(targetDir, backupSecrets));
      }
      report.backup = report.backups.find((n) => n.endsWith('.db')) ?? null;
      report.replaced = true;
      // The backup must read back before the old DB is moved aside.
      assertDbHealthy(backupDb, b.fingerprint, 'backup');
    }

    step('journal');
    writeJsonAtomic(path.join(targetDir, JOURNAL), {
      formatVersion: FORMAT_VERSION,
      startedAt: new Date(now).toISOString(),
      source: legacyDir,
      target: targetDir,
      replacing,
      backups: report.backups,
      staged: [dataFp ? 'data.db' : null, agentFp ? 'agent.db' : null, secretsRaw ? SECRETS : null].filter(Boolean),
    });
    journalWritten = true;

    // Move the old target files aside (never delete them yet). Sidecars go with their DB.
    step('aside');
    for (const name of ['data.db', 'data.db-wal', 'data.db-shm', 'agent.db', 'agent.db-wal', 'agent.db-shm', SECRETS]) {
      const from = path.join(targetDir, name);
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, path.join(replacedDir, name));
      movedAside.push(name);
    }

    // Commit by rename, data.db last, then fsync.
    step('commit');
    for (const name of ['agent.db', SECRETS, 'data.db']) {
      const from = path.join(staging, name);
      if (!fs.existsSync(from)) continue;
      fs.renameSync(from, path.join(targetDir, name));
      committed.push(name);
    }
    for (const name of committed) fsyncPath(path.join(targetDir, name));
    fsyncPath(targetDir);

    step('postcommit');
    const committedFp = verifyCommitted({ targetDir, targetDb, targetAgent, dataFp, agentFp, secretsRaw });

    step('marker');
    report.status = 'completed';
    report.importedAt = new Date().toISOString();
    report.files = [...committed];
    report.tables = committedFp.tables;
    report.totalRows = Object.values(committedFp.tables).reduce((a, b) => a + b, 0);
    writeJsonAtomic(path.join(targetDir, MARKER), markerOf(report, stamp));
    // From here the import is committed; a cleanup failure is a note, not a rollback.
    fsyncPath(targetDir);
    try { removeStrictIfExists(replacedDir); } catch (e) { report.notes.push(`could not remove the replaced-file folder: ${e.message}`); }
    try { removeStrictIfExists(staging); } catch (e) { report.notes.push(`could not remove the staging folder: ${e.message}`); }
    try { removeStrictIfExists(path.join(targetDir, JOURNAL)); } catch (e) { report.notes.push(`could not remove the import journal: ${e.message}`); }
    report.durationMs = Date.now() - started;
    return report;
  } catch (err) {
    const reason = err?.code === 'no-space' || err?.code === 'target-in-use' || err?.code === 'legacy-in-use' || err?.code === 'legacy-vault-key-missing' || err?.code === 'integrity' ? err.code : 'import-failed';
    report.status = reason === 'no-space' || reason === 'target-in-use' || reason === 'legacy-in-use' || reason === 'legacy-vault-key-missing' ? 'refused' : 'failed';
    report.reason = reason;
    report.notes.push(err?.message ?? String(err));
    // Roll back any replacement. Files before the journal step never touched the target.
    if (journalWritten || movedAside.length > 0) {
      const rollback = rollbackTarget({ targetDir, replacedDir, staging, movedAside, committed, journalWritten });
      report.notes.push(...rollback.notes);
      report.rolledBack = rollback.ok;
    } else {
      report.rolledBack = true;
    }
    if (staging) { try { removeStrictIfExists(staging); } catch { /* reported above */ } }
    // If restoring the old files failed, .legacy-import-replaced/ is the only copy left:
    // keep it and say where it is. Only a clean rollback removes it.
    if (replacedDir && report.rolledBack !== false) {
      try { removeStrictIfExists(replacedDir); } catch (e) { report.notes.push(`could not remove ${REPLACED}: ${e.message}`); }
    } else if (replacedDir && fs.existsSync(replacedDir)) {
      report.notes.push(`the previous desktop files are kept in ${path.join(targetDir, REPLACED)}; restore them by hand`);
    }
    report.durationMs = Date.now() - started;
    return report;
  } finally {
    if (lock) lock.release();
  }
}

// ---------------------------------------------------------------------------
// Inspection

function emptySide() {
  return {
    path: null, exists: false, valid: false, empty: true, sizeBytes: 0,
    tableCount: 0, totalRows: 0, tables: {}, migration: null, reason: 'missing',
    agentDb: { exists: false, sizeBytes: 0, tableCount: 0, migration: null },
    secretsFile: false,
  };
}

function inspectSide(dir, dbName) {
  const dbFile = dir ? path.join(dir, dbName) : null;
  const side = emptySide();
  side.path = dbFile;
  if (!dir || !dbFile) return side;
  if (!fs.existsSync(dir)) {
    side.reason = 'no-folder';
    return side;
  }
  const insp = inspectDatabase(dbFile);
  Object.assign(side, {
    exists: insp.exists, valid: insp.valid, empty: insp.empty, sizeBytes: insp.sizeBytes,
    tableCount: insp.tableCount, totalRows: insp.totalRows, tables: insp.tables,
    migration: insp.migration, reason: insp.reason,
  });
  const agent = path.join(dir, 'agent.db');
  const ai = inspectDatabase(agent);
  side.agentDb = { exists: ai.exists, sizeBytes: ai.sizeBytes, tableCount: ai.tableCount, migration: ai.migration, valid: ai.valid };
  side.secretsFile = fs.existsSync(path.join(dir, SECRETS));
  return side;
}

/** Read-only inspection. Never writes, never creates sidecars on a quiescent DB. */
export function inspectDatabase(file) {
  const out = { exists: false, valid: false, empty: true, sizeBytes: 0, tableCount: 0, totalRows: 0, tables: {}, migration: null, reason: 'missing' };
  if (!file || !fs.existsSync(file)) return out;
  out.exists = true;
  let st;
  try { st = fs.statSync(file); } catch { out.reason = 'unreadable'; return out; }
  out.sizeBytes = st.size;
  if (!st.isFile() || st.size === 0) {
    out.reason = st.size === 0 ? 'empty' : 'not-a-file';
    return out;
  }
  const before = sidecarState(file);
  let db = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    const quick = db.pragma('quick_check', { simple: true });
    if (quick !== 'ok') { out.reason = 'integrity'; return out; }
    const names = tableNames(db);
    if (names.length === 0) { out.reason = 'empty'; return out; }
    const tables = {};
    for (const name of names) tables[name] = countRows(db, name);
    const mig = migrationOf(db, names);
    return { ...out, valid: true, empty: false, tableCount: names.length, totalRows: Object.values(tables).reduce((a, b) => a + b, 0), tables, migration: mig };
  } catch {
    out.reason = 'unreadable';
    return out;
  } finally {
    closeQuietly(db);
    // A read-only open of a WAL database still creates -wal/-shm. Remove only the
    // ones this inspection created, so a status check never modifies the folder.
    cleanupCreatedSidecars(file, before);
  }
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
}

function countRows(db, name) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n;
}

function migrationOf(db, names) {
  const table = names.includes(MAIN_MIGRATIONS) ? MAIN_MIGRATIONS : (names.includes(AGENT_MIGRATIONS) ? AGENT_MIGRATIONS : null);
  if (!table) return null;
  const row = db.prepare(`SELECT MAX(version) AS v FROM ${table}`).get();
  return row?.v ?? 0;
}

// ---------------------------------------------------------------------------
// Snapshots and verification

// Refuse while another process has a write transaction on `file`. The writer connection
// is closed while a read-only connection is still open, so SQLite does not checkpoint
// (which would rewrite the file); sidecars this probe created are removed again.
function assertNotInUse(file, code, message) {
  if (!fs.existsSync(file)) return;
  const before = sidecarState(file);
  let locker = null;
  let reader = null;
  try {
    locker = new Database(file, { timeout: 0 });
    locker.pragma('busy_timeout = 0');
    locker.exec('BEGIN IMMEDIATE');
    reader = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    reader.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
  } catch {
    throw fail(code, message);
  } finally {
    if (locker) { try { locker.exec('ROLLBACK'); } catch { /* already ended */ } }
    closeQuietly(locker);
    closeQuietly(reader);
    cleanupCreatedSidecars(file, before);
  }
}

// A consistent VACUUM INTO snapshot with the source held against writers, but WITHOUT
// checkpointing it: a writer connection holds BEGIN IMMEDIATE while a read-only
// connection takes the snapshot. Closing the writer first (the reader is still open)
// means SQLite does not checkpoint on close; closing the read-only connection never
// checkpoints. Sidecars this run created are removed afterwards.
function snapshotDatabase(srcFile, destFile) {
  if (!fs.existsSync(srcFile)) throw fail('missing', `${path.basename(srcFile)} is missing`);
  const before = sidecarState(srcFile);
  let locker = null;
  let reader = null;
  let copy = null;
  try {
    locker = new Database(srcFile, { timeout: 0 });
    locker.pragma('busy_timeout = 0');
    try {
      locker.exec('BEGIN IMMEDIATE');
    } catch {
      throw fail('legacy-in-use', `${path.basename(srcFile)} is open by another process`);
    }
    reader = new Database(srcFile, { readonly: true, fileMustExist: true, timeout: 0 });
    const quick = reader.pragma('quick_check', { simple: true });
    if (quick !== 'ok') throw fail('integrity', `quick_check on ${path.basename(srcFile)}: ${quick}`);
    const srcFp = fingerprint(reader);
    const migration = migrationOf(reader, Object.keys(srcFp.tables));
    reader.prepare('VACUUM INTO ?').run(destFile);
    for (const suffix of ['-wal', '-shm']) removeStrictIfExists(`${destFile}${suffix}`);
    copy = new Database(destFile, { readonly: true, fileMustExist: true, timeout: 0 });
    const ic = copy.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw fail('integrity', `integrity_check on the copy of ${path.basename(srcFile)}: ${ic}`);
    const dstFp = fingerprint(copy);
    compareFingerprints(srcFp, dstFp, `copy of ${path.basename(srcFile)}`);
    const destMigration = migrationOf(copy, Object.keys(dstFp.tables));
    if (migration !== destMigration) throw fail('integrity', `schema_migrations version differs in the copy of ${path.basename(srcFile)}`);
    return { fingerprint: srcFp, migration, before };
  } finally {
    closeQuietly(copy);
    // Roll back and close the writer while the reader is still open: no checkpoint.
    if (locker) { try { locker.exec('ROLLBACK'); } catch { /* already ended */ } }
    closeQuietly(locker);
    closeQuietly(reader);
    cleanupCreatedSidecars(srcFile, before);
  }
}

function sidecarState(file) {
  return {
    wal: fs.existsSync(`${file}-wal`),
    shm: fs.existsSync(`${file}-shm`),
  };
}

function cleanupCreatedSidecars(file, before) {
  for (const [suffix, key] of [['-wal', 'wal'], ['-shm', 'shm']]) {
    const p = `${file}${suffix}`;
    if (before[key] || !fs.existsSync(p)) continue;
    // A non-empty WAL that we did not have before means a writer raced us; keep it
    // (deleting it could lose data) and let the caller's note/report show the folder
    // changed.
    try {
      if (suffix === '-wal' && fs.statSync(p).size > 0) continue;
      fs.unlinkSync(p);
    } catch { /* best effort: a leftover empty sidecar is harmless */ }
  }
}

function fingerprint(db) {
  const names = tableNames(db);
  const tables = {};
  for (const name of names) tables[name] = countRows(db, name);
  const sequence = names.includes('sqlite_sequence')
    ? JSON.stringify(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all())
    : null;
  return { tables, sequence };
}

function compareFingerprints(src, dst, label) {
  const a = Object.keys(src.tables);
  const b = Object.keys(dst.tables);
  if (a.length !== b.length || a.some((n, i) => n !== b[i])) throw fail('integrity', `table list differs for ${label}`);
  for (const name of a) {
    if (src.tables[name] !== dst.tables[name]) {
      throw fail('integrity', `row count mismatch in ${name} (${label}): ${src.tables[name]} source, ${dst.tables[name]} copy`);
    }
  }
  if (src.sequence !== dst.sequence) throw fail('integrity', `sqlite_sequence differs for ${label}`);
}

function assertDbHealthy(file, want, label) {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw fail('integrity', `integrity_check on ${label}: ${ic}`);
    compareFingerprints(want, fingerprint(db), label);
  } finally {
    db.close();
  }
}

function verifyCommitted({ targetDir, targetDb, targetAgent, dataFp, agentFp, secretsRaw }) {
  const db = new Database(targetDb, { readonly: true, fileMustExist: true, timeout: 0 });
  let fp;
  try {
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw fail('integrity', `integrity_check on the imported data.db: ${ic}`);
    fp = fingerprint(db);
    compareFingerprints(dataFp.fingerprint, fp, 'imported data.db');
    if (migrationOf(db, Object.keys(fp.tables)) !== dataFp.migration) {
      throw fail('integrity', 'the imported data.db schema_migrations version changed');
    }
  } finally {
    db.close();
  }
  if (agentFp) {
    const a = new Database(targetAgent, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const ic = a.pragma('integrity_check', { simple: true });
      if (ic !== 'ok') throw fail('integrity', `integrity_check on the imported agent.db: ${ic}`);
      compareFingerprints(agentFp.fingerprint, fingerprint(a), 'imported agent.db');
    } finally {
      a.close();
    }
  }
  if (secretsRaw) {
    if (fs.readFileSync(path.join(targetDir, SECRETS), 'utf8') !== secretsRaw) {
      throw fail('integrity', 'the copied .dev-secrets.json differs from the old app file');
    }
  }
  return fp;
}

// ---------------------------------------------------------------------------
// Rollback

function rollbackTarget({ targetDir, replacedDir, staging, movedAside, committed, journalWritten }) {
  const notes = [];
  let ok = true;
  for (const name of committed.slice().reverse()) {
    try { removeStrictIfExists(path.join(targetDir, name)); } catch (e) { ok = false; notes.push(`rollback could not remove ${name}: ${e.message}`); }
  }
  if (replacedDir) {
    for (const name of movedAside) {
      const from = path.join(replacedDir, name);
      if (!fs.existsSync(from)) continue;
      try {
        fs.renameSync(from, path.join(targetDir, name));
      } catch (e) {
        ok = false;
        notes.push(`rollback could not restore ${name}: ${e.message}`);
      }
    }
  }
  if (journalWritten) {
    try { removeStrictIfExists(path.join(targetDir, JOURNAL)); } catch (e) { ok = false; notes.push(`could not remove the journal: ${e.message}`); }
  }
  try { fsyncPath(targetDir); } catch { /* best effort */ }
  if (ok) notes.push('the desktop data folder was restored to its previous files');
  // A restored target must read back.
  const restored = path.join(targetDir, 'data.db');
  if (fs.existsSync(restored)) {
    try { inspectDatabase(restored); } catch { /* inspection never throws */ }
  }
  void staging;
  return { ok, notes };
}

// ---------------------------------------------------------------------------
// Locks, markers and small helpers

function acquireLock(targetDir) {
  const lockDir = path.join(targetDir, LOCK);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      writePrivate(path.join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      return {
        release() {
          const owner = readJson(path.join(lockDir, 'owner.json'));
          if (owner?.pid === process.pid) removeStrictIfExists(lockDir);
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const owner = readJson(path.join(lockDir, 'owner.json'));
    if (owner === null) {
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 5000) removeStrictIfExists(lockDir);
      } catch { /* gone */ }
    } else if (!pidAlive(owner.pid)) {
      removeStrictIfExists(lockDir);
    }
    if (Date.now() > deadline) throw fail('busy', 'another import is running (its lock is still held); nothing was changed');
    sleepSync(200);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

function readMarker(targetDir) {
  const file = path.join(targetDir, MARKER);
  if (!fs.existsSync(file)) return { present: false, value: null, error: null };
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { present: true, value, error: null };
  } catch (err) {
    return { present: true, value: null, error: err.message };
  }
}

function markerOf(report, stamp) {
  return {
    formatVersion: FORMAT_VERSION,
    status: 'completed',
    importedAt: report.importedAt,
    source: report.legacy.path ? path.dirname(report.legacy.path) : null,
    target: report.target.path ? path.dirname(report.target.path) : null,
    stamp,
    replaced: report.replaced,
    backups: report.backups,
    files: report.files,
    secretsImported: report.secretsImported,
    migration: report.migration,
    agentMigration: report.agentMigration,
    tables: report.tables,
    totalRows: report.totalRows,
  };
}

function readSecrets(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw fail('legacy-vault-key-missing', 'the old app .dev-secrets.json is not valid JSON'); }
  for (const key of ['jwtSecret', 'vaultKey']) {
    const v = parsed?.[key];
    if (typeof v !== 'string' || v.length < MIN_SECRET_LEN || /[\u0000-\u001f\u007f]/.test(v)) {
      throw fail('legacy-vault-key-missing', `the old app .dev-secrets.json has no usable ${key}`);
    }
  }
  return { raw, values: parsed };
}

function uniqueStamp(targetDir, now) {
  const base = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  let stamp = base;
  for (let i = 2; i < 100; i++) {
    const p = path.join(targetDir, 'backups', `${BACKUP_PREFIX}${stamp}.db`);
    if (!fs.existsSync(p)) break;
    stamp = `${base}-${i}`;
  }
  return stamp;
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function finishStatus(report, started) {
  report.durationMs = Date.now() - started;
  return report;
}

function rel(base, p) {
  return path.relative(base, p);
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function mb(bytes) {
  return Math.round((bytes / 1024 ** 2) * 10) / 10;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writePrivate(file, body, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncPath(path.dirname(file));
}

function fsyncPath(p) {
  const fd = fs.openSync(p, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function removeStrictIfExists(p) {
  if (!fs.existsSync(p) && !isSymlink(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function isSymlink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function closeQuietly(db) {
  try { if (db && db.open) db.close(); } catch { /* already closed */ }
}

// ---------------------------------------------------------------------------
// CLI (the desktop host runs this same file from the staged core)

export function parseArgs(argv) {
  const out = { action: 'status', legacyDir: null, targetDir: null, force: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status') out.action = 'status';
    else if (a === '--import') out.action = 'import';
    else if (a === '--force') out.force = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--legacy') out.legacyDir = argv[++i] ?? null;
    else if (a === '--target') out.targetDir = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function humanReport(r) {
  const lines = [
    'LLM-IDE — old Mac app data import',
    `Status:  ${r.status}${r.reason ? ` (${r.reason})` : ''}`,
    `Source:  ${r.legacy?.path ?? '(none)'}${r.legacy?.exists ? ` — ${mb(r.legacy.sizeBytes)} MB, ${r.legacy.totalRows} rows, schema v${r.legacy.migration}` : ''}`,
    `Target:  ${r.target?.path ?? '(none)'}${r.target?.exists ? ` — ${mb(r.target.sizeBytes)} MB${r.target.empty ? ' (empty)' : ''}, schema v${r.target.migration ?? 0}` : ' — not created yet'}`,
  ];
  if (r.status === 'already-imported') lines.push(`Imported: ${r.marker?.importedAt ?? 'yes'}${r.marker?.backups?.length ? `; backups: ${r.marker.backups.join(', ')}` : ''}`);
  if (r.needsForce) lines.push('The desktop data folder already holds data. Pass --force to replace it; a verified backup is written first.');
  if (r.status === 'completed') {
    lines.push(`Imported: ${r.importedAt}`);
    lines.push(`Rows:     ${r.totalRows} in ${r.tables ? Object.keys(r.tables).length : 0} tables (schema v${r.migration})`);
    if (r.backups?.length) lines.push(`Backups (old desktop data): ${r.backups.join(', ')}`);
  }
  for (const n of r.notes ?? []) lines.push(`Note:    ${n}`);
  if (r.status === 'ready' || r.status === 'needs-confirmation') lines.push('Run with --import (and --force if asked) to import. The old folder is never modified.');
  return lines.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (args.help) {
    console.log([
      'Usage: node extension/kb/legacy-import.mjs [--status | --import] [options]',
      '',
      '  --status            read-only report (default)',
      '  --import            import the old Mac app data into the desktop data folder',
      '  --force             replace a non-empty desktop data folder (a verified backup is written first)',
      '  --legacy <dir>      source (default: ~/Library/Application Support/llm-ide/system)',
      '  --target <dir>      destination (default: ~/Library/Application Support/llm-ide-desktop/core)',
      '  --json              print one JSON report on stdout',
      '',
      'The old folder is never changed. Exit 0 = completed/no-op, 1 = failed, 2 = refused.',
    ].join('\n'));
    return 0;
  }
  const legacyDir = args.legacyDir ?? defaultLegacyDir();
  const targetDir = args.targetDir ?? defaultTargetDir();
  const report = args.action === 'import'
    ? runLegacyImport({ legacyDir, targetDir, force: args.force })
    : legacyImportStatus({ legacyDir, targetDir });
  if (args.json) console.log(JSON.stringify(report));
  else console.log(humanReport(report));
  if (args.action === 'status') return 0;
  if (report.status === 'completed' || report.status === 'noop' || report.status === 'already-imported') return 0;
  if (report.status === 'failed') return 1;
  return 2;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(fs.realpathSync(process.argv[1])).href === pathToFileURL(fs.realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main();
}
