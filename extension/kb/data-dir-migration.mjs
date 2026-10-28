// One-time MOVE of the repo-level kb/ data into the system data dir (LLMIDE_DATA_DIR).
//
// Runs at the top of server.mjs, imported before config and the DB are read
// (kb/data-dir-boot.mjs), and never throws. It runs only when ALL hold, otherwise
// it reports why it skipped:
//   - LLMIDE_DATA_DIR is set, and not under the test runner
//   - LLMIDE_DB_PATH is not set (an explicit DB path wins; nothing to move)
//   - <dataDir>/data.db does not exist (or is an empty file with no marker: see below)
//   - the legacy <repo>/kb/data.db exists
//
// Every run takes a lock first: <dataDir>/.migrating-lock (a directory, created
// atomically, holding owner.json with the pid). A lock held by a live process
// makes this run wait (bounded) and then re-check; a lock whose pid is dead is
// stale and is taken over. Nothing is wiped or deleted while another live
// process holds the lock, and the data.db check is repeated under the lock.
//
// The move (all under the lock):
//   1. free-space preflight: 2x the legacy data.db + agent.db bytes on the data dir's volume
//   2. lock the legacy data.db (and agent.db) EXCLUSIVELY for the whole move: a
//      read fails while ANY other connection has the file open, idle servers
//      included. If the lock cannot be taken, nothing moves (legacy-in-use)
//   3. snapshot each with VACUUM INTO and verify the copy: integrity_check, and
//      per-table row counts and sqlite_sequence against the locked source
//   4. stage the dev secrets (byte-identical), agent.db and agent-sdk/ (verbatim
//      symlinks; file list, sizes and link targets verified) in <dataDir>/.migrating
//   5. commit by rename, data.db last; fsync the committed files and the dir;
//      verify the committed files again (integrity_check, counts, sqlite_sequence,
//      secrets bytes, agent-sdk manifest). Any failure up to here rolls back.
//   6. grace step: checkpoint the legacy WAL, rename the legacy files to
//      <name>.pre-move (kept for ONE boot), write the MOVED notice
// The .pre-move files are deleted by the next server boot, after that boot has
// opened the new DB healthily (completeGraceAfterHealthyBoot). A failure in step 6
// keeps the verified new copy and says what is left in notes.
//
// Signals: the move is synchronous, so a SIGTERM that arrives during it is only
// seen when the event loop resumes. The handler installed here records it, and
// the process exits right after the move has finished (committed or rolled back).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { setDataDirOverride, setDataMigrationReport } from '../core/data-dir.mjs';
import { legacyTripwire, MOVED_NOTICE } from './legacy-tripwire.mjs';

const MARKER = 'migrated-from.json';
const DEV_SECRETS = '.dev-secrets.json';
const LOCK_DIR = '.migrating-lock';
const OWNER = '.migrating-owner';
const PRE_MOVE = '.pre-move';
// agent-sdk/ holds per-user engine homes (transcripts and credentials). It is
// moved only under this cap; above it, it stays in the legacy kb and says so.
const MAX_SDK_BYTES = 200 * 1024 ** 2;
// Files an interrupted move may have left in the data dir. data.db is NOT in
// this list: a data.db is never removed by the retry path.
const WIPEABLE = ['agent.db', 'agent.db-wal', 'agent.db-shm', 'agent-sdk', DEV_SECRETS, MARKER];
// data.db is the commit point: it is renamed into place last.
const COMMIT_ORDER = ['agent.db', 'agent-sdk', DEV_SECRETS, MARKER, 'data.db'];
const BOOT_ID = crypto.randomUUID();
const DEFAULT_LOCK_WAIT_MS = 200_000;

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const defaultFreeBytes = (dir) => { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); };

/**
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {string} opts.root repo root (holds `kb/`)
 * @param {string|null} [opts.appVersion] recorded in the marker
 * @param {(step: string) => void} [opts.fault] test hook: throws to simulate a failure at a step
 * @param {number} [opts.sdkCapBytes] agent-sdk/ size cap (tests)
 * @param {number} [opts.lockWaitMs] how long to wait for another live migration
 * @param {(dir: string) => number} [opts.freeBytes] free space on a path's volume (tests)
 * @param {string} [opts.bootId] identifies this boot (tests)
 * @returns {object} the migration report (also stored for /health)
 */
export function runDataDirMigration(opts = {}) {
  let termRequested = false;
  const onTerm = () => { termRequested = true; };
  process.on('SIGTERM', onTerm);
  try {
    return runMigration(opts);
  } finally {
    // The move is done (committed or rolled back). Only now may the process stop.
    setImmediate(() => {
      process.removeListener('SIGTERM', onTerm);
      if (termRequested) process.exit(143);
    });
  }
}

function runMigration({
  env = process.env, root, appVersion = null, fault = null, sdkCapBytes = MAX_SDK_BYTES,
  lockWaitMs = DEFAULT_LOCK_WAIT_MS, freeBytes = defaultFreeBytes, bootId = BOOT_ID,
}) {
  const started = Date.now();
  const report = {
    status: 'skipped', reason: null, dataDir: null, from: null, tables: null, notes: [],
    healthNotes: [], legacyDiverged: null, graceCleanupDue: null, durationMs: 0,
  };
  const finish = (status, reason = null) => {
    report.status = status;
    report.reason = reason;
    report.durationMs = Date.now() - started;
    setDataMigrationReport(report);
    return report;
  };

  try {
    const rawDataDir = typeof env.LLMIDE_DATA_DIR === 'string' ? env.LLMIDE_DATA_DIR.trim() : '';
    if (!rawDataDir) {
      // The repo kb layout. After a move it must not be opened as if it were fresh.
      if (!env.NODE_TEST_CONTEXT) {
        const trip = legacyTripwire({ root, env });
        if (trip?.refuse) {
          report.notes.push(trip.message);
          return finish('refused', 'moved-legacy-tripwire');
        }
        if (trip) report.notes.push(trip.message);
      }
      return finish('skipped', 'no-data-dir');
    }
    // Never move or delete anything under the test runner.
    if (env.NODE_TEST_CONTEXT) return finish('skipped', 'test-run');
    if (typeof env.LLMIDE_DB_PATH === 'string' && env.LLMIDE_DB_PATH.trim()) {
      return finish('skipped', 'db-path-overridden');
    }

    const dataDir = path.resolve(rawDataDir);
    report.dataDir = dataDir;
    // getDb() needs the directory to exist; create it private whatever happens next.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const lock = acquireLock(dataDir, lockWaitMs);
    if (!lock) {
      setDataDirOverride(null);
      report.notes.push('another process held the data dir migration lock for too long; using the legacy location for this run, nothing was changed');
      return finish('fallback', 'lock-timeout');
    }
    try {
      return underLock({ env, root, appVersion, fault, sdkCapBytes, freeBytes, bootId, dataDir, report, finish });
    } finally {
      lock.release();
    }
  } catch (err) {
    setDataDirOverride(null);
    report.notes.push(`unexpected: ${err?.message ?? err}`);
    return finish('fallback', 'unexpected-error');
  }
}

function underLock({ env, root, appVersion, fault, sdkCapBytes, freeBytes, bootId, dataDir, report, finish }) {
  const legacyDir = path.join(root, 'kb');
  const legacyDb = path.join(legacyDir, 'data.db');
  const newDb = path.join(dataDir, 'data.db');
  const marker = readMarker(dataDir);

  if (fs.existsSync(newDb)) {
    if (!marker && isEmptyDb(newDb)) {
      // A zero-byte or table-less data.db with no marker is not a migrated DB.
      // Move it aside (never delete it) and migrate again.
      const aside = `${newDb}.empty-${Date.now()}`;
      fs.renameSync(newDb, aside);
      for (const s of ['-wal', '-shm']) { try { fs.renameSync(`${newDb}${s}`, `${aside}${s}`); } catch { /* none */ } }
      report.notes.push(`data.db had no tables and no migration marker; moved aside to ${path.basename(aside)}`);
    } else {
      // Already moved. A legacy data.db that exists again means something recreated it.
      report.legacyDiverged = checkLegacyDivergence(legacyDir, dataDir);
      if (marker && marker.graceBootPending && marker.completed && marker.movedBootId !== bootId) {
        report.graceCleanupDue = { legacyDir, dataDir };
      }
      return finish('skipped', 'data-dir-has-db');
    }
  }

  report.from = legacyDb;
  if (!fs.existsSync(legacyDb)) return finish('skipped', 'no-legacy-db');

  return moveLegacy({ dataDir, legacyDir, legacyDb, env, appVersion, fault, sdkCapBytes, freeBytes, bootId, report, finish });
}

function moveLegacy({ dataDir, legacyDir, legacyDb, env, appVersion, fault, sdkCapBytes, freeBytes, bootId, report, finish }) {
  const step = (name) => { if (fault) fault(name); };
  const staging = path.join(dataDir, '.migrating');
  const ownerFile = path.join(dataDir, OWNER);
  const legacyAgent = path.join(legacyDir, 'agent.db');
  // An agent.db in the data dir blocks the move unless it is a leftover of an
  // interrupted move of ours (the wipe below removes it).
  const wipeAllowed = fs.existsSync(ownerFile) && !fs.existsSync(path.join(dataDir, 'data.db'));
  const agentBlocked = fs.existsSync(path.join(dataDir, 'agent.db')) && !wipeAllowed;
  const moveAgent = !(typeof env.LLMIDE_AGENT_DB_PATH === 'string' && env.LLMIDE_AGENT_DB_PATH.trim())
    && fs.existsSync(legacyAgent) && !agentBlocked;
  if (fs.existsSync(legacyAgent) && !moveAgent) {
    report.notes.push('agent.db not moved (already present in the data dir, or LLMIDE_AGENT_DB_PATH is set); the legacy file stays');
  }

  // 1. Free-space preflight, before anything is written.
  const needed = 2 * (fs.statSync(legacyDb).size + (moveAgent ? fs.statSync(legacyAgent).size : 0));
  const free = freeBytes(dataDir);
  if (free < needed) {
    report.notes.push(`not enough free space in the data dir's volume (${Math.round(free / 1024 ** 2)} MB free, ${Math.round(needed / 1024 ** 2)} MB needed); nothing was moved`);
    setDataDirOverride(null);
    return finish('fallback', 'no-space');
  }

  // 2. Wipe what an interrupted move of ours left behind. Only when data.db is
  // absent, rechecked right before the wipe, and never data.db itself.
  if (wipeAllowed) {
    {
      const discarded = WIPEABLE.filter((n) => fs.existsSync(path.join(dataDir, n)));
      for (const name of WIPEABLE) removeStrict(path.join(dataDir, name));
      if (discarded.length) report.notes.push(`discarded ${discarded.length} leftover file(s) of an interrupted migration`);
    }
  }
  writeFileAtomic(ownerFile, JSON.stringify({ startedAt: new Date().toISOString(), pid: process.pid, bootId, owns: [...WIPEABLE, 'data.db'] }, null, 2) + '\n');

  let legacyHandle = null;
  let agentHandle = null;
  let secrets = null;     // { raw, staged }
  let sdkMoved = false;
  let agentMoved = false;
  const committed = [];   // names renamed into the data dir by this run
  try {
    rmTreeStrictIfExists(staging);
    fs.mkdirSync(staging, { mode: 0o700 });

    // 2+3. Lock the legacy DBs, snapshot, verify against the locked source.
    legacyHandle = lockLegacy(legacyDb);
    if (moveAgent) agentHandle = lockLegacy(legacyAgent);
    step('db');
    const dbFp = snapshotAndVerify(legacyHandle, path.join(staging, 'data.db'));
    report.tables = dbFp.tables;
    step('verify');
    if (moveAgent) {
      step('agent');
      snapshotAndVerify(agentHandle, path.join(staging, 'agent.db'));
      agentMoved = true;
    }

    // 4. Stage the secrets and agent-sdk/ (verbatim, verified).
    step('secrets');
    secrets = stageSecrets({ legacyFile: path.join(legacyDir, DEV_SECRETS), dataDir, staging, env, report });
    const sdkSrc = path.join(legacyDir, 'agent-sdk');
    let sdkManifest = null;
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
        const want = treeManifest(sdkSrc);
        fs.cpSync(sdkSrc, path.join(staging, 'agent-sdk'), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        const got = treeManifest(path.join(staging, 'agent-sdk'));
        if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error('agent-sdk/ copy differs from the original (file list, sizes or link targets)');
        sdkManifest = want;
        sdkMoved = true;
      }
    }
    if (fs.existsSync(path.join(legacyDir, 'backups'))) {
      const note = `backups/ not moved (${Math.round(treeBytes(path.join(legacyDir, 'backups')) / 1024 ** 2)} MB stay in the legacy kb); new backups go to the data dir`;
      report.notes.push(note);
      report.healthNotes.push(note);
    }

    step('marker');
    const marker = {
      source: legacyDb,
      migratedAt: new Date().toISOString(),
      movedBootId: bootId,
      appVersion,
      tables: report.tables,
      agentDb: agentMoved,
      backups: false,
      agentSdk: sdkMoved,
      completed: false,
      graceBootPending: true,
    };
    writeFileAtomic(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`);

    // 5. Commit by rename, data.db last. Up to the post-commit check, a failure rolls back.
    for (const name of COMMIT_ORDER) {
      const from = path.join(staging, name);
      if (!fs.existsSync(from)) continue;
      step(`commit:${name}`);
      fs.renameSync(from, path.join(dataDir, name));
      committed.push(name);
    }
    step('fsync');
    for (const name of committed) fsyncPath(path.join(dataDir, name));
    fsyncPath(dataDir);
    step('postcommit');
    verifyCommitted({ dataDir, dbFp, agentMoved, secrets, sdkManifest });
  } catch (err) {
    closeQuietly(legacyHandle);
    closeQuietly(agentHandle);
    for (const name of committed.slice().reverse()) {
      try { removeStrict(path.join(dataDir, name)); } catch (e) { report.notes.push(`rollback could not remove ${name}: ${e.message}`); }
    }
    rmTreeStrictIfExists(staging);
    removeQuietly(ownerFile);
    setDataDirOverride(null);
    const reason = err?.code === 'LEGACY_IN_USE' ? 'legacy-in-use' : 'copy-failed';
    report.notes.push(`${reason === 'legacy-in-use' ? 'not moved' : 'move failed'}: ${err?.message ?? err}; using the legacy location for this run, legacy files untouched`);
    return finish('fallback', reason);
  }

  // 6. Grace step. The verified new copy is committed; from here a failure keeps it.
  const removed = [];
  try {
    if (legacyHandle) {
      step('grace:checkpoint');
      legacyHandle.pragma('wal_checkpoint(TRUNCATE)');
      step('grace:data');
      renameStrict(legacyDb, `${legacyDb}${PRE_MOVE}`);
      removed.push('data.db');
      for (const s of ['-wal', '-shm']) removeStrict(`${legacyDb}${s}`);
    }
    if (agentMoved) {
      step('grace:agent');
      agentHandle.pragma('wal_checkpoint(TRUNCATE)');
      renameStrict(legacyAgent, `${legacyAgent}${PRE_MOVE}`);
      removed.push('agent.db');
      for (const s of ['-wal', '-shm']) removeStrict(`${legacyAgent}${s}`);
    }
    if (secrets && fs.existsSync(path.join(legacyDir, DEV_SECRETS))) {
      step('grace:secrets');
      renameStrict(path.join(legacyDir, DEV_SECRETS), path.join(legacyDir, `${DEV_SECRETS}${PRE_MOVE}`));
      removed.push(DEV_SECRETS);
    }
    if (sdkMoved) {
      step('grace:agent-sdk');
      renameStrict(path.join(legacyDir, 'agent-sdk'), path.join(legacyDir, `agent-sdk${PRE_MOVE}`));
      removed.push('agent-sdk/');
    }
    closeQuietly(legacyHandle);
    closeQuietly(agentHandle);
    legacyHandle = null;
    agentHandle = null;
    writeFileAtomic(path.join(dataDir, MARKER), `${JSON.stringify({ ...readMarker(dataDir), completed: true, graceBootPending: true, movedBootId: bootId, movedFiles: removed }, null, 2)}\n`);
    report.removedLegacy = removed;
    writeMovedNotice(legacyDir, dataDir, report);
  } catch (err) {
    closeQuietly(legacyHandle);
    closeQuietly(agentHandle);
    report.notes.push(`legacy move incomplete (${err?.message ?? err}); the new copy is verified and kept. Moved so far: ${removed.join(', ') || 'nothing'}. Check ${legacyDir} by hand.`);
  }

  rmTreeStrictIfExists(staging);
  removeQuietly(ownerFile);
  report.legacyDiverged = false;
  return finish('migrated', null);
}

// Runs only after this boot opened the new DB healthily (server.mjs). Deletes the
// .pre-move copies left by the previous boot's move. Keeps them if anything is off.
export function completeGraceAfterHealthyBoot(report) {
  const due = report?.graceCleanupDue;
  if (!due) return { removed: [], kept: [] };
  const removed = [];
  const kept = [];
  for (const name of ['data.db', 'agent.db', DEV_SECRETS, 'agent-sdk']) {
    const p = path.join(due.legacyDir, `${name}${PRE_MOVE}`);
    if (!fs.existsSync(p)) continue;
    try { removeStrict(p); removed.push(path.basename(p)); } catch (err) { kept.push(`${path.basename(p)} (${err.message})`); }
  }
  if (kept.length === 0) {
    const m = readMarker(due.dataDir);
    if (m) writeFileAtomic(path.join(due.dataDir, MARKER), `${JSON.stringify({ ...m, graceBootPending: false, graceCompletedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  return { removed, kept };
}

// ---------------------------------------------------------------------------
// Lock

function acquireLock(dataDir, waitMs) {
  const lockDir = path.join(dataDir, LOCK_DIR);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      writeFileAtomic(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return {
        release() {
          const owner = readJson(path.join(lockDir, 'owner.json'));
          if (owner?.pid === process.pid) removeQuietly(lockDir, true);
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const owner = readJson(path.join(lockDir, 'owner.json'));
    if (owner === null) {
      // Being written by another process, or left by a crash before the owner was written.
      const age = Date.now() - fs.statSync(lockDir).mtimeMs;
      if (age > 5000) removeQuietly(lockDir, true);
    } else if (!pidAlive(owner.pid)) {
      removeQuietly(lockDir, true); // stale: its process is gone
    }
    if (Date.now() > deadline) return null;
    sleepSync(250);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

// ---------------------------------------------------------------------------
// Legacy and new DBs

// Exclusive lock on a legacy DB, held open. Fails while any other connection has it open.
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

// VACUUM INTO from the locked source; verify the copy against the same source's
// fingerprint. Returns the source fingerprint.
function snapshotAndVerify(src, dest) {
  src.prepare('VACUUM INTO ?').run(dest);
  const srcFp = fingerprint(src);
  const copy = new Database(dest, { fileMustExist: true });
  let dstFp;
  try {
    const ic = copy.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw new Error(`integrity_check on ${path.basename(dest)}: ${ic}`);
    dstFp = fingerprint(copy);
  } finally {
    copy.close();
  }
  for (const suffix of ['-wal', '-shm']) removeQuietly(`${dest}${suffix}`);
  compareFingerprints(srcFp, dstFp, path.basename(dest));
  return srcFp;
}

// Row counts of every table (sqlite_sequence included) and its rows.
function fingerprint(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
  const tables = {};
  for (const name of names) {
    tables[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n;
  }
  const hasSeq = names.includes('sqlite_sequence');
  const sequence = hasSeq
    ? JSON.stringify(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all())
    : null;
  return { tables, sequence };
}

function compareFingerprints(src, dst, label) {
  const a = Object.keys(src.tables);
  const b = Object.keys(dst.tables);
  if (a.length !== b.length || a.some((n, i) => n !== b[i])) throw new Error(`table list differs for ${label}`);
  for (const name of a) {
    if (src.tables[name] !== dst.tables[name]) {
      throw new Error(`row count mismatch in ${name} (${label}): ${src.tables[name]} source, ${dst.tables[name]} copy`);
    }
  }
  if (src.sequence !== dst.sequence) throw new Error(`sqlite_sequence differs for ${label}`);
}

// Re-verify the committed files: a full integrity_check, the same fingerprint, the
// secrets bytes and the agent-sdk manifest.
function verifyCommitted({ dataDir, dbFp, agentMoved, secrets, sdkManifest }) {
  const db = new Database(path.join(dataDir, 'data.db'), { fileMustExist: true, readonly: true });
  try {
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw new Error(`committed data.db integrity_check: ${ic}`);
    compareFingerprints(dbFp, fingerprint(db), 'committed data.db');
  } finally {
    db.close();
  }
  if (agentMoved) {
    const a = new Database(path.join(dataDir, 'agent.db'), { fileMustExist: true, readonly: true });
    try {
      const ic = a.pragma('integrity_check', { simple: true });
      if (ic !== 'ok') throw new Error(`committed agent.db integrity_check: ${ic}`);
    } finally {
      a.close();
    }
  }
  if (secrets) {
    if (fs.readFileSync(path.join(dataDir, DEV_SECRETS), 'utf8') !== secrets.raw) {
      throw new Error('the copied dev secrets differ from the legacy file');
    }
  }
  if (sdkManifest) {
    if (JSON.stringify(treeManifest(path.join(dataDir, 'agent-sdk'))) !== JSON.stringify(sdkManifest)) {
      throw new Error('the committed agent-sdk/ differs from the original');
    }
  }
}

// data.db has no tables, or is zero bytes. Unreadable counts as not empty (never touched).
function isEmptyDb(file) {
  if (fs.statSync(file).size === 0) return true;
  let db;
  try {
    db = new Database(file, { fileMustExist: true, readonly: true });
    return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n === 0;
  } catch {
    return false;
  } finally {
    if (db) db.close();
  }
}

// Stage <repo>/kb/.dev-secrets.json byte for byte. Refuses (the caller falls back)
// when a legacy vault holds secrets but no key file exists and LLMIDE_VAULT_KEY
// is not set, or when the data dir holds a different key.
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
    if (fs.readFileSync(target, 'utf8') !== raw) throw new Error('data dir already holds a different dev secrets file');
    return { raw, staged: false };
  }
  writeFileAtomic(path.join(staging, DEV_SECRETS), raw, 0o600);
  return { raw, staged: true };
}

// ---------------------------------------------------------------------------
// Small helpers

// true: the legacy data.db exists again after the move (MOVED notice present).
// null: no marker, so the move is not known to have happened.
function checkLegacyDivergence(legacyDir, dataDir) {
  if (!readMarker(dataDir)) return null;
  return fs.existsSync(path.join(legacyDir, 'data.db')) && fs.existsSync(path.join(legacyDir, MOVED_NOTICE));
}

function writeMovedNotice(legacyDir, dataDir, report) {
  const text = [
    'The live data was MOVED to the app data directory.',
    '',
    `Moved on:   ${new Date().toISOString()}`,
    `Now lives:  ${dataDir}`,
    `Moved here: ${(report.removedLegacy ?? []).join(', ') || 'nothing'}`,
    `Tables:     ${Object.keys(report.tables ?? {}).length} (verified before the move)`,
    '',
    'For ONE boot the originals are kept as <name>.pre-move in this folder. The next',
    'server boot deletes them, after that boot has opened the new DB healthily. If',
    'that next boot looks wrong, do not start it: restore from the .pre-move files',
    '(see docs/how-to/data-location-and-rollback.md). After that there is no copy',
    'except backups.',
    '',
    'Still here: backups/ (old DB copies, not moved; delete them by hand once you',
    'have checked the new location).',
    '',
    'Rollback is NOT automatic after the .pre-move files are gone. Restore a backup',
    'from the data directory (backups/data-<unix>.db, the newest two are kept). Any',
    'write after the newest backup is lost unless it is still in the data directory.',
    '',
  ].join('\n');
  try {
    writeFileAtomic(path.join(legacyDir, MOVED_NOTICE), text);
  } catch (err) {
    report.notes.push(`could not write ${MOVED_NOTICE}: ${err.message}`);
  }
}

function readMarker(dataDir) {
  return readJson(path.join(dataDir, MARKER));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Write to a temp file, fsync it, rename over the target, fsync the directory.
function writeFileAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w', mode);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fsyncPath(path.dirname(file));
}

// fsync a file or a directory. Node has no F_FULLFSYNC: on macOS this is a plain fsync.
function fsyncPath(p) {
  const fd = fs.openSync(p, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Manifest of a tree: every entry's relative path, kind, size (files) or link target (symlinks).
function treeManifest(dir) {
  const out = [];
  const walk = (cur) => {
    for (const ent of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(cur, ent.name);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out.push({ rel, kind: 'link', target: fs.readlinkSync(p) });
      else if (st.isDirectory()) { out.push({ rel, kind: 'dir' }); walk(p); }
      else if (st.isFile()) out.push({ rel, kind: 'file', size: st.size });
      else out.push({ rel, kind: 'other' });
    }
  };
  walk(dir);
  return out;
}

function treeBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const m of treeManifest(dir)) if (m.kind === 'file') total += m.size;
  return total;
}

// Remove, and throw when the path is still there afterwards (ENOENT is not a failure).
function removeStrict(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (pathPresent(p)) throw new Error(`could not remove ${p}`);
}

// Present as a file, directory or symlink (a dangling symlink counts).
function pathPresent(p) {
  try { fs.lstatSync(p); return true; } catch { return false; }
}

function rmTreeStrictIfExists(p) {
  if (fs.existsSync(p)) removeStrict(p);
}

function renameStrict(from, to) {
  fs.renameSync(from, to);
  if (pathPresent(from)) throw new Error(`could not move ${from}`);
}

function removeQuietly(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort: callers that need certainty use removeStrict */ }
}

function closeQuietly(db) {
  try { if (db && db.open) db.close(); } catch { /* already closed */ }
}
