// One-time MOVE of the repo-level kb/ into the system data dir (LLMIDE_DATA_DIR).
//
// Runs at the very top of server.mjs, imported before config and the DB are
// read (kb/data-dir-boot.mjs), and never throws. It runs only when ALL hold,
// otherwise it reports why it skipped:
//   - LLMIDE_DATA_DIR is set, and not under the test runner
//   - LLMIDE_DB_PATH is not set (an explicit DB path wins; nothing to move)
//   - <dataDir>/data.db does not exist yet (a second boot skips)
//   - the legacy <repo>/kb/data.db exists
//
// The legacy files are held open with an EXCLUSIVE lock for the whole move.
// That read fails with SQLITE_BUSY while ANY other connection has the file
// open, idle servers included, so when it succeeds nothing else can use the
// legacy DB until the move ends. If the lock cannot be taken, nothing is moved
// and this run uses the legacy location (logged as legacy-in-use).
//
// Steps:
//   1. lock legacy data.db (and agent.db, if it is moved)
//   2. snapshot each with VACUUM INTO (includes WAL content), verify the copy:
//      integrity_check and per-table row counts against the locked source
//   3. stage .dev-secrets.json (the vault key; byte-identical, mode 0600),
//      agent.db and agent-sdk/ (within a 200 MB cap) in <dataDir>/.migrating
//   4. commit by rename, data.db last, then verify the committed data.db counts
//      and the secrets bytes. Any mismatch rolls the commit back and falls back.
//   5. only now delete the legacy copies (-wal, -shm, data.db; agent.db and its
//      -wal/-shm; legacy .dev-secrets.json once the copy is byte-equal; agent-sdk/
//      when it was moved). backups/ is never moved and never deleted.
// Any failure before step 5 removes what this run created, leaves the legacy
// files untouched and falls back to the legacy location for this process
// (setDataDirOverride(null)), so the server never boots on a half-moved DB.
//
// VACUUM INTO rather than better-sqlite3's db.backup(): backup() is async, and
// config reads the paths synchronously at import time.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { setDataDirOverride, setDataMigrationReport } from '../core/data-dir.mjs';

const MARKER = 'migrated-from.json';
const DEV_SECRETS = '.dev-secrets.json';
// agent-sdk/ holds per-user engine homes (transcripts and credentials). It is
// moved only under this cap; above it, it stays in the legacy kb and says so.
const MAX_SDK_BYTES = 200 * 1024 ** 2;
// Written at the start of a move, removed when it ends. It lists exactly what a
// move may create in the data dir, so a retry can tell its own leftovers (a
// crash between renames) from files a person put there.
const OWNER = '.migrating-owner';
const OWNED = ['data.db', 'data.db-wal', 'data.db-shm', 'agent.db', 'agent.db-wal', 'agent.db-shm',
  'agent-sdk', DEV_SECRETS, MARKER];
// data.db is the commit point: it is renamed into place last.
const COMMIT_ORDER = ['agent.db', 'agent-sdk', DEV_SECRETS, MARKER, 'data.db'];

/**
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {string} opts.root repo root (holds `kb/`)
 * @param {string|null} [opts.appVersion] recorded in the marker
 * @param {(step: string) => void} [opts.fault] test hook: throws to simulate a failure at a step
 * @param {number} [opts.sdkCapBytes] agent-sdk/ size cap (tests)
 * @returns {object} the migration report (also stored for /health)
 */
export function runDataDirMigration({ env = process.env, root, appVersion = null, fault = null, sdkCapBytes = MAX_SDK_BYTES } = {}) {
  const started = Date.now();
  const report = { status: 'skipped', reason: null, dataDir: null, from: null, tables: null, notes: [], healthNotes: [], legacyDiverged: null, durationMs: 0 };
  const finish = (status, reason = null) => {
    report.status = status;
    report.reason = reason;
    report.durationMs = Date.now() - started;
    setDataMigrationReport(report);
    return report;
  };

  try {
    const rawDataDir = typeof env.LLMIDE_DATA_DIR === 'string' ? env.LLMIDE_DATA_DIR.trim() : '';
    if (!rawDataDir) return finish('skipped', 'no-data-dir');
    // Never move or delete anything under the test runner.
    if (env.NODE_TEST_CONTEXT) return finish('skipped', 'test-run');
    if (typeof env.LLMIDE_DB_PATH === 'string' && env.LLMIDE_DB_PATH.trim()) {
      return finish('skipped', 'db-path-overridden');
    }

    const dataDir = path.resolve(rawDataDir);
    report.dataDir = dataDir;
    // getDb() needs the directory to exist; create it private whatever happens next.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const legacyDir = path.join(root, 'kb');
    const newDb = path.join(dataDir, 'data.db');
    if (fs.existsSync(newDb)) {
      rmTree(path.join(dataDir, OWNER)); // an interrupted run that had in fact committed data.db
      // Already moved. A legacy data.db that exists again means something (an
      // older server, an adopted dev server) created a fork after the move.
      report.legacyDiverged = checkLegacyDivergence(legacyDir, dataDir);
      return finish('skipped', 'data-dir-has-db');
    }

    const legacyDb = path.join(legacyDir, 'data.db');
    report.from = legacyDb;
    if (!fs.existsSync(legacyDb)) return finish('skipped', 'no-legacy-db');

    return moveLegacy({ dataDir, legacyDir, legacyDb, env, appVersion, fault, sdkCapBytes, report, finish });
  } catch (err) {
    setDataDirOverride(null);
    report.notes.push(`unexpected: ${err?.message ?? err}`);
    return finish('fallback', 'unexpected-error');
  }
}

function moveLegacy({ dataDir, legacyDir, legacyDb, env, appVersion, fault, sdkCapBytes, report, finish }) {
  const staging = path.join(dataDir, '.migrating');
  const ownerFile = path.join(dataDir, OWNER);
  const moved = []; // names committed into dataDir by this run, rolled back on failure
  const step = (name) => { if (fault) fault(name); };
  // A previous run that died between commits left files behind with no data.db.
  // data.db is the commit point, so those files cannot be trusted: discard the
  // ones it recorded as its own, then move again.
  if (fs.existsSync(ownerFile)) {
    const discarded = OWNED.filter((n) => fs.existsSync(path.join(dataDir, n)));
    for (const name of OWNED) rmTree(path.join(dataDir, name));
    if (discarded.length) report.notes.push(`discarded ${discarded.length} leftover file(s) of an interrupted migration`);
  }
  fs.writeFileSync(ownerFile, `${JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, owns: OWNED }, null, 2)}\n`, { mode: 0o600 });

  const legacyAgent = path.join(legacyDir, 'agent.db');
  const moveAgent = !(typeof env.LLMIDE_AGENT_DB_PATH === 'string' && env.LLMIDE_AGENT_DB_PATH.trim())
    && fs.existsSync(legacyAgent) && !fs.existsSync(path.join(dataDir, 'agent.db'));
  if (fs.existsSync(legacyAgent) && !moveAgent) {
    report.notes.push('agent.db not moved (already present in the data dir, or LLMIDE_AGENT_DB_PATH is set); the legacy file stays');
  }

  let legacyHandle = null;
  let agentHandle = null;
  let secrets = null;       // { raw, staged }
  let sdkMoved = false;
  let agentMoved = false;
  try {
    rmTree(staging);
    fs.mkdirSync(staging, { mode: 0o700 });

    // 1. Lock the legacy files for the whole move. Failure: nothing moved.
    legacyHandle = lockLegacy(legacyDb);
    if (moveAgent) agentHandle = lockLegacy(legacyAgent);

    // 2. Snapshot and verify.
    step('db');
    report.tables = snapshotAndVerify(legacyHandle, path.join(staging, 'data.db'));
    step('verify');
    if (moveAgent) {
      step('agent');
      snapshotAndVerify(agentHandle, path.join(staging, 'agent.db'));
      agentMoved = true;
    }

    // 3. Stage the secrets, agent-sdk/ (cap), and nothing else. backups/ stays.
    step('secrets');
    secrets = stageSecrets({ legacyFile: path.join(legacyDir, DEV_SECRETS), dataDir, staging, env, report });
    const sdkSrc = path.join(legacyDir, 'agent-sdk');
    if (fs.existsSync(sdkSrc)) {
      step('agent-sdk');
      const bytes = treeBytes(sdkSrc);
      const mb = Math.round(bytes / 1024 ** 2);
      if (bytes > sdkCapBytes) {
        const note = `agent-sdk/ not moved (${mb} MB exceeds the ${Math.round(sdkCapBytes / 1024 ** 2)} MB cap; it stays in the legacy kb); per-user agent logins must be re-established`;
        report.notes.push(note);
        report.healthNotes.push(note);
      } else if (fs.existsSync(path.join(dataDir, 'agent-sdk'))) {
        report.notes.push('agent-sdk/ already present in data dir; not moved');
      } else {
        fs.cpSync(sdkSrc, path.join(staging, 'agent-sdk'), { recursive: true, errorOnExist: true, force: false });
        sdkMoved = true;
      }
    }
    const backupsNote = fs.existsSync(path.join(legacyDir, 'backups'))
      ? `backups/ not moved (${Math.round(treeBytes(path.join(legacyDir, 'backups')) / 1024 ** 2)} MB stay in the legacy kb); new backups go to the data dir`
      : null;
    if (backupsNote) { report.notes.push(backupsNote); report.healthNotes.push(backupsNote); }

    step('marker');
    const marker = {
      source: legacyDb,
      migratedAt: new Date().toISOString(),
      appVersion,
      tables: report.tables,
      agentDb: agentMoved,
      backups: false,
      agentSdk: sdkMoved,
    };
    fs.writeFileSync(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });

    // 4. Commit by rename, data.db last. Then verify what is now in the data dir.
    for (const name of COMMIT_ORDER) {
      const from = path.join(staging, name);
      if (!fs.existsSync(from)) continue;
      step(`commit:${name}`);
      fs.renameSync(from, path.join(dataDir, name));
      moved.push(name);
    }
    step('postcommit');
    verifyCommitted(path.join(dataDir, 'data.db'), report.tables);
    if (secrets) {
      const now = fs.readFileSync(path.join(dataDir, DEV_SECRETS), 'utf8');
      if (now !== secrets.raw) throw new Error('the copied dev secrets differ from the legacy file');
    }
  } catch (err) {
    closeQuietly(legacyHandle);
    closeQuietly(agentHandle);
    for (const name of moved) rmTree(path.join(dataDir, name));
    for (const suffix of ['-wal', '-shm']) rmTree(path.join(dataDir, `data.db${suffix}`));
    rmTree(staging);
    rmTree(ownerFile);
    setDataDirOverride(null);
    const reason = err?.code === 'LEGACY_IN_USE' ? 'legacy-in-use' : 'copy-failed';
    report.notes.push(`${reason === 'legacy-in-use' ? 'not moved' : 'move failed'}: ${err?.message ?? err}; using the legacy location for this run, legacy files untouched`);
    return finish('fallback', reason);
  }

  // 5. Everything is verified and committed. Delete the legacy copies while the
  // legacy DB is still held exclusively. Nothing is deleted before this point.
  try {
    step('delete:wal');
    for (const suffix of ['-wal', '-shm']) rmTree(`${legacyDb}${suffix}`);
    rmTree(legacyDb);
    const removed = ['data.db'];
    if (agentMoved) {
      for (const suffix of ['-wal', '-shm']) rmTree(`${legacyAgent}${suffix}`);
      rmTree(legacyAgent);
      removed.push('agent.db');
    }
    if (secrets?.raw && fs.readFileSync(path.join(legacyDir, DEV_SECRETS), 'utf8') === fs.readFileSync(path.join(dataDir, DEV_SECRETS), 'utf8')) {
      step('delete:secrets');
      rmTree(path.join(legacyDir, DEV_SECRETS));
      removed.push(DEV_SECRETS);
    }
    if (sdkMoved) {
      step('delete:agent-sdk');
      rmTree(path.join(legacyDir, 'agent-sdk'));
      removed.push('agent-sdk/');
    }
    report.removedLegacy = removed;
    closeQuietly(legacyHandle);
    closeQuietly(agentHandle);
    // Closing the last handle can checkpoint and remove the WAL itself; make sure nothing is left.
    for (const name of ['data.db-wal', 'data.db-shm']) rmTree(path.join(legacyDir, name));
  } catch (err) {
    closeQuietly(legacyHandle);
    closeQuietly(agentHandle);
    // The new copy is verified and committed; keep it. Say what is left behind.
    report.notes.push(`legacy removal incomplete (${err?.message ?? err}); delete the remaining legacy files in ${legacyDir} by hand`);
  }

  rmTree(staging);
  rmTree(ownerFile);
  report.legacyDiverged = false;
  writeMovedNotice(legacyDir, dataDir, report);
  return finish('migrated', null);
}

// Take an EXCLUSIVE lock on a legacy DB and keep the connection open. The first
// read fails with SQLITE_BUSY while any other connection has the file open,
// idle or not (a BEGIN IMMEDIATE probe misses an idle server, which holds no
// write lock between transactions).
function lockLegacy(file) {
  const db = new Database(file, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
  } catch (err) {
    closeQuietly(db);
    const e = new Error(`${path.basename(file)} is in use by another process (${err.code ?? err.message})`);
    e.code = 'LEGACY_IN_USE';
    throw e;
  }
  return db;
}

// VACUUM INTO from the locked source, verify the copy against that same
// source's counts. Returns the verified per-table counts.
function snapshotAndVerify(src, dest) {
  src.prepare('VACUUM INTO ?').run(dest);
  const srcCounts = tableCounts(src);
  const copy = new Database(dest, { fileMustExist: true });
  let dstCounts;
  try {
    const ic = copy.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw new Error(`integrity_check on ${path.basename(dest)}: ${ic}`);
    dstCounts = tableCounts(copy);
  } finally {
    copy.close();
  }
  for (const suffix of ['-wal', '-shm']) rmTree(`${dest}${suffix}`);
  const names = Object.keys(srcCounts);
  if (names.length !== Object.keys(dstCounts).length) {
    throw new Error(`table count mismatch for ${path.basename(dest)}`);
  }
  for (const name of names) {
    if (dstCounts[name] !== srcCounts[name]) {
      throw new Error(`row count mismatch in ${name}: ${srcCounts[name]} source, ${dstCounts[name]} copy`);
    }
  }
  return srcCounts;
}

// Re-open the committed data.db and check it matches the verified counts.
function verifyCommitted(file, expected) {
  const db = new Database(file, { fileMustExist: true, readonly: true });
  try {
    const got = tableCounts(db);
    for (const [name, n] of Object.entries(expected)) {
      if (got[name] !== n) throw new Error(`committed data.db differs in ${name}: ${n} expected, ${got[name]} found`);
    }
  } finally {
    db.close();
  }
}

// Stage <repo>/kb/.dev-secrets.json (the vault key) for the copy, byte for byte.
// Returns { raw, staged }, or null when there is no legacy file. Refuses (the
// caller falls back) when a legacy vault holds secrets but no key file exists
// and LLMIDE_VAULT_KEY is not set, or when the data dir holds a different key.
function stageSecrets({ legacyFile, dataDir, staging, env, report }) {
  const target = path.join(dataDir, DEV_SECRETS);
  if (!fs.existsSync(legacyFile)) {
    if ((report.tables?.user_secrets ?? 0) > 0 && !(env.LLMIDE_VAULT_KEY ?? '').trim()) {
      throw new Error('legacy vault holds secrets but its key file is missing and LLMIDE_VAULT_KEY is not set');
    }
    report.notes.push('no legacy dev secrets file; the data dir generates one on first boot');
    return null;
  }
  const raw = fs.readFileSync(legacyFile, 'utf8');
  const parsed = JSON.parse(raw); // throws on a corrupt file: fall back, never guess a key
  if (typeof parsed?.jwtSecret !== 'string' || typeof parsed?.vaultKey !== 'string') {
    throw new Error('legacy dev secrets file is missing jwtSecret or vaultKey');
  }
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') !== raw) {
      throw new Error('data dir already holds a different dev secrets file');
    }
    return { raw, staged: false };
  }
  const dest = path.join(staging, DEV_SECRETS);
  fs.writeFileSync(dest, raw, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
  return { raw, staged: true };
}

// true: the legacy data.db exists again after the move (something recreated it).
// null: no marker, so the move is not known to have happened.
function checkLegacyDivergence(legacyDir, dataDir) {
  try { JSON.parse(fs.readFileSync(path.join(dataDir, MARKER), 'utf8')); } catch { return null; }
  return fs.existsSync(path.join(legacyDir, 'data.db'));
}

// Plain-text notice left in the legacy kb. It says what moved and that there is
// no automatic rollback.
function writeMovedNotice(legacyDir, dataDir, report) {
  const text = [
    'The live data was MOVED to the app data directory. The copies in this folder were deleted.',
    '',
    `Moved on:   ${new Date().toISOString()}`,
    `Now lives:  ${dataDir}`,
    `Moved:      ${(report.removedLegacy ?? []).join(', ') || 'nothing removed'}`,
    `Tables:     ${Object.keys(report.tables ?? {}).length} (row counts verified before the legacy copies were deleted)`,
    'Still here: backups/ (old DB copies, not moved; delete them by hand once you have checked the new location)',
    '',
    'Rollback is NOT automatic. The move deleted the legacy database. To go back,',
    'restore a backup from the data directory (backups/data-<unix>.db, the newest',
    'two are kept; see docs/how-to/data-location-and-rollback.md). Anything written',
    'after the newest backup is lost unless it is still in the data directory.',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(legacyDir, 'MOVED-TO-APP-SUPPORT.txt'), text);
  } catch (err) {
    report.notes.push(`could not write MOVED-TO-APP-SUPPORT.txt: ${err.message}`);
  }
}

function closeQuietly(db) {
  try { if (db && db.open) db.close(); } catch { /* already closed */ }
}

function tableCounts(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
  const counts = {};
  for (const name of names) {
    counts[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n;
  }
  return counts;
}

function treeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}
