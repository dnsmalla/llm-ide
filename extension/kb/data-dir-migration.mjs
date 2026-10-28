// One-time copy of the repo-level kb/ into the system data dir (LLMIDE_DATA_DIR).
//
// Runs at the very top of server.mjs (imported before config and the DB are
// read) and never throws. It copies; it never moves or deletes the legacy
// files, which stay as the N-1 rollback (an older server still reads <repo>/kb).
//
// Runs only when ALL of these hold, otherwise it reports why it skipped:
//   - LLMIDE_DATA_DIR is set, and not under the test runner
//   - LLMIDE_DB_PATH is not set (an explicit DB path wins; nothing to move)
//   - <dataDir>/data.db does not exist yet (idempotent: a second boot skips)
//   - the legacy <repo>/kb/data.db exists
//
// Steps: probe that no process holds the legacy DBs (BEGIN IMMEDIATE); snapshot
// data.db (and agent.db) with VACUUM INTO, which includes WAL content; verify
// PRAGMA integrity_check and per-table row counts against the source; copy
// backups/ and agent-sdk/ (skipped with a note above 2 GB); stage everything in
// <dataDir>/.migrating, then commit by renaming into place with data.db last
// and the marker written before it. Any failure removes what this run created
// and falls back to the legacy location for this process (setDataDirOverride(null)),
// so the server never boots on a half-copied DB.
//
// VACUUM INTO rather than better-sqlite3's db.backup(): backup() is async, and
// config reads the paths synchronously at import time, so the copy must finish
// synchronously before the server reads its configuration.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { setDataDirOverride, setDataMigrationReport } from '../core/data-dir.mjs';

const MARKER = 'migrated-from.json';
const MAX_TREE_BYTES = 2 * 1024 ** 3;
const DEV_SECRETS = '.dev-secrets.json';
const COMMIT_ORDER = ['agent.db', 'backups', 'agent-sdk', DEV_SECRETS, MARKER, 'data.db'];

/**
 * @param {object} [opts]
 * @param {Record<string,string|undefined>} [opts.env]
 * @param {string} opts.root repo root (holds `kb/`)
 * @param {string|null} [opts.appVersion] recorded in the marker
 * @param {(step: string) => void} [opts.fault] test hook: throws to simulate a failure at a step
 * @returns {object} the migration report (also stored for /health)
 */
export function runDataDirMigration({ env = process.env, root, appVersion = null, fault = null } = {}) {
  const started = Date.now();
  const report = { status: 'skipped', reason: null, dataDir: null, from: null, tables: null, notes: [], durationMs: 0 };
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
    if (env.NODE_TEST_CONTEXT) return finish('skipped', 'test-run');
    if (typeof env.LLMIDE_DB_PATH === 'string' && env.LLMIDE_DB_PATH.trim()) {
      return finish('skipped', 'db-path-overridden');
    }

    const dataDir = path.resolve(rawDataDir);
    report.dataDir = dataDir;
    // getDb() needs the directory to exist; create it private whatever happens next.
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const newDb = path.join(dataDir, 'data.db');
    if (fs.existsSync(newDb)) {
      // Already moved: say whether the legacy kb has been written to since
      // (a fork: an older server or an adopted dev server is still using it).
      report.legacyDiverged = checkLegacyDivergence(path.join(root, 'kb'), dataDir);
      return finish('skipped', 'data-dir-has-db');
    }

    const legacyDir = path.join(root, 'kb');
    const legacyDb = path.join(legacyDir, 'data.db');
    report.from = legacyDb;
    if (!fs.existsSync(legacyDb)) return finish('skipped', 'no-legacy-db');

    return copyLegacy({ dataDir, legacyDir, legacyDb, env, appVersion, fault, report, finish });
  } catch (err) {
    setDataDirOverride(null);
    report.notes.push(`unexpected: ${err?.message ?? err}`);
    return finish('fallback', 'unexpected-error');
  }
}

function copyLegacy({ dataDir, legacyDir, legacyDb, env, appVersion, fault, report, finish }) {
  const staging = path.join(dataDir, '.migrating');
  const moved = []; // names moved into dataDir by this run, removed on failure
  const step = (name) => { if (fault) fault(name); };
  const legacyAgent = path.join(legacyDir, 'agent.db');
  const copyAgent = !(typeof env.LLMIDE_AGENT_DB_PATH === 'string' && env.LLMIDE_AGENT_DB_PATH.trim())
    && fs.existsSync(legacyAgent);

  try {
    rmTree(staging);
    fs.mkdirSync(staging, { mode: 0o700 });

    step('db');
    report.tables = snapshotAndVerify(legacyDb, path.join(staging, 'data.db'));

    // The dev secrets are the only copy of the vault key: without them every
    // vault-encrypted secret is lost. Copy them, never regenerate.
    step('secrets');
    copySecrets({ legacyFile: path.join(legacyDir, DEV_SECRETS), dataDir, staging, env, report });

    let agentCopied = false;
    if (copyAgent) {
      step('agent');
      if (fs.existsSync(path.join(dataDir, 'agent.db'))) {
        report.notes.push('agent.db already present in data dir; not copied');
      } else {
        snapshotAndVerify(legacyAgent, path.join(staging, 'agent.db'));
        agentCopied = true;
      }
    }

    const trees = { backups: false, 'agent-sdk': false };
    for (const name of Object.keys(trees)) {
      step(name);
      const src = path.join(legacyDir, name);
      if (!fs.existsSync(src)) continue;
      const bytes = treeBytes(src);
      if (bytes > MAX_TREE_BYTES) {
        report.notes.push(`${name}/ skipped: ${Math.round(bytes / 1024 ** 3)} GB exceeds the 2 GB copy cap`);
        continue;
      }
      if (fs.existsSync(path.join(dataDir, name))) {
        report.notes.push(`${name}/ already present in data dir; not copied`);
        continue;
      }
      fs.cpSync(src, path.join(staging, name), { recursive: true, errorOnExist: true, force: false });
      trees[name] = true;
    }

    step('marker');
    const marker = {
      source: legacyDb,
      migratedAt: new Date().toISOString(),
      appVersion,
      tables: report.tables,
      agentDb: agentCopied,
      backups: trees.backups,
      agentSdk: trees['agent-sdk'],
      // What the legacy DB looked like when it was left behind. A later boot
      // compares against this to notice a fork.
      legacyBaseline: legacyFingerprint(legacyDir),
    };
    fs.writeFileSync(path.join(staging, MARKER), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });

    // Commit: everything except data.db first; data.db last is the commit point.
    for (const name of COMMIT_ORDER) {
      const from = path.join(staging, name);
      if (!fs.existsSync(from)) continue;
      step(`commit:${name}`);
      const to = path.join(dataDir, name);
      fs.renameSync(from, to);
      moved.push(name);
    }
    rmTree(staging);
    report.legacyDiverged = false;
    writeMovedNotice(legacyDir, dataDir, report);
    return finish('migrated', null);
  } catch (err) {
    for (const name of moved) rmTree(path.join(dataDir, name));
    for (const suffix of ['-wal', '-shm']) {
      rmTree(path.join(dataDir, `data.db${suffix}`));
    }
    rmTree(staging);
    setDataDirOverride(null);
    report.notes.push(`migration failed, using the legacy location for this run: ${err?.message ?? err}`);
    return finish('fallback', 'copy-failed');
  }
}

// Snapshot one legacy DB and verify the copy. The source connection takes an
// EXCLUSIVE lock first: that read fails with SQLITE_BUSY while any other
// connection has the file open, idle or not (a BEGIN IMMEDIATE probe misses an
// idle server, which holds no write lock between transactions). Holding the
// lock until the counts are taken means VACUUM INTO and the counts see the
// same data. Returns the per-table counts that were verified.
function snapshotAndVerify(src, dest) {
  const db = new Database(src, { fileMustExist: true, timeout: 0 });
  let srcCounts;
  try {
    db.pragma('locking_mode = EXCLUSIVE');
    try {
      db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
    } catch (err) {
      throw new Error(`${path.basename(src)} is in use by another process (${err.code ?? err.message})`);
    }
    db.prepare('VACUUM INTO ?').run(dest);
    srcCounts = tableCounts(db);
  } finally {
    db.close();
  }

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
    throw new Error(`table count mismatch for ${path.basename(src)}`);
  }
  for (const name of names) {
    if (dstCounts[name] !== srcCounts[name]) {
      throw new Error(`row count mismatch in ${name}: ${srcCounts[name]} source, ${dstCounts[name]} copy`);
    }
  }
  return srcCounts;
}

// Copy <repo>/kb/.dev-secrets.json into the staging dir (mode 0600). Refuses
// (the caller falls back) when a legacy vault holds secrets but no key file
// exists and LLMIDE_VAULT_KEY is not set, or when the data dir already holds a
// different key. An already identical file is fine.
function copySecrets({ legacyFile, dataDir, staging, env, report }) {
  const target = path.join(dataDir, DEV_SECRETS);
  if (!fs.existsSync(legacyFile)) {
    if ((report.tables?.user_secrets ?? 0) > 0 && !(env.LLMIDE_VAULT_KEY ?? '').trim()) {
      throw new Error('legacy vault holds secrets but its key file is missing and LLMIDE_VAULT_KEY is not set');
    }
    report.notes.push('no legacy dev secrets file; the data dir generates one on first boot');
    return;
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
    return;
  }
  const dest = path.join(staging, DEV_SECRETS);
  fs.writeFileSync(dest, raw, { mode: 0o600 });
  fs.chmodSync(dest, 0o600);
}

// Size and mtime of the legacy data.db and its -wal. A server writing to the
// legacy kb changes at least one of them (writes land in the WAL first).
function legacyFingerprint(legacyDir) {
  const stat = (f) => {
    try { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; }
  };
  return {
    dataDb: stat(path.join(legacyDir, 'data.db')),
    wal: stat(path.join(legacyDir, 'data.db-wal')),
    takenAt: new Date().toISOString(),
  };
}

// true: the legacy DB changed since it was migrated (or disappeared).
// null: no marker, so there is nothing to compare.
function checkLegacyDivergence(legacyDir, dataDir) {
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(dataDir, MARKER), 'utf8')); } catch { return null; }
  const base = marker?.legacyBaseline;
  if (!base) return null;
  const now = legacyFingerprint(legacyDir);
  if (!now.dataDb) return true;
  const same = (a, b) => (a === null && b === null) || (a && b && a.size === b.size && a.mtimeMs === b.mtimeMs);
  return !(same(base.dataDb, now.dataDb) && same(base.wal, now.wal));
}

// Plain-text notice in the legacy kb, so a person (or a later agent) who finds
// the old files knows where the live data went and how to roll back.
function writeMovedNotice(legacyDir, dataDir, report) {
  const text = [
    'The live data moved to the app data directory.',
    '',
    `Moved on:   ${new Date().toISOString()}`,
    `Now lives:  ${dataDir}`,
    '  data.db, agent.db, .dev-secrets.json (vault key), agent-sdk/ (agent credentials, mode 0600)',
    'Not copied: backups/ (old backups stay here; new ones go to the data dir)',
    `Tables copied: ${Object.keys(report.tables ?? {}).length} (row counts verified)`,
    '',
    'This directory is now a stale copy. Writing to it forks the data: the server',
    'reads the data dir, so anything written here is invisible to it.',
    '',
    'To roll back to this copy, stop the server and read docs/how-to/data-location-and-rollback.md',
    'in the repository (LLMIDE_USE_REPO_KB=1 runs an old-layout server on this directory).',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(path.join(legacyDir, 'MOVED-TO-APP-SUPPORT.txt'), text);
  } catch (err) {
    report.notes.push(`could not write MOVED-TO-APP-SUPPORT.txt: ${err.message}`);
  }
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
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile()) total += fs.statSync(p).size;
      if (total > MAX_TREE_BYTES) return total; // enough to decide
    }
  }
  return total;
}

function rmTree(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}
