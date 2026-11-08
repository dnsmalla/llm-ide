// Verified restore of a data.db + agent.db backup pair. This is the offline
// counterpart of kb/backup-databases.mjs: the server's backups are VACUUM INTO
// snapshots (single clean files, agent.db beside data.db), and restoring one
// must never replace a live database with a file that was not read back first.
//
// Contract:
//   - VERIFY BEFORE RESTORE. Both files are opened read-only and must pass
//     integrity_check + quick_check, have tables, and (data.db) an applied
//     schema_migrations version. Nothing live is touched until both pass.
//   - QUIESCENT. The live files must have no other writer (`BEGIN IMMEDIATE`);
//     a running server makes the restore refuse with `live-in-use`. This is an
//     offline operation (scripts/restore-backup.mjs); there is no HTTP route.
//   - TWO-PHASE, PAIR-WIDE. Every pre-restore snapshot and every staged copy is
//     written and verified before the first live file moves. Old live files are
//     moved aside (not deleted), the staged files are renamed in, and both are
//     verified again. Any failure removes the new files and moves the old ones
//     back — for both data.db and agent.db, not just the one that failed.
//   - KEEP THE SAFETY NET. The pre-restore copies stay beside the database
//     (`*.pre-restore-<stamp>.db`), so a later problem can still be undone.

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from '../core/config.mjs';

const MAIN_MIGRATIONS = 'schema_migrations';
const AGENT_MIGRATIONS = 'agent_schema_migrations';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function closeQuietly(db) {
  try { if (db && db.open) db.close(); } catch { /* already closed */ }
}

function sidecarState(file) {
  return { wal: fs.existsSync(`${file}-wal`), shm: fs.existsSync(`${file}-shm`) };
}

function cleanupCreatedSidecars(file, before) {
  for (const [suffix, key] of [['-wal', 'wal'], ['-shm', 'shm']]) {
    const p = `${file}${suffix}`;
    if (before[key] || !fs.existsSync(p)) continue;
    try {
      if (suffix === '-wal' && fs.statSync(p).size > 0) continue;
      fs.unlinkSync(p);
    } catch { /* harmless leftover */ }
  }
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();
}

function countRows(db, name) {
  return db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n;
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

function compareFingerprints(a, b, label) {
  const ak = Object.keys(a.tables);
  const bk = Object.keys(b.tables);
  if (ak.length !== bk.length || ak.some((n, i) => n !== bk[i])) throw fail('verify', `table list differs for ${label}`);
  for (const n of ak) {
    if (a.tables[n] !== b.tables[n]) throw fail('verify', `row count mismatch in ${n} (${label}): ${a.tables[n]} expected, ${b.tables[n]} found`);
  }
  if (a.sequence !== b.sequence) throw fail('verify', `sqlite_sequence differs for ${label}`);
}

function migrationOf(db, kind) {
  const names = tableNames(db);
  const table = kind === 'agent' ? AGENT_MIGRATIONS : MAIN_MIGRATIONS;
  if (!names.includes(table)) return null;
  return db.prepare(`SELECT MAX(version) AS v FROM ${table}`).get().v ?? 0;
}

/**
 * Read-only verification of a backup file. Never modifies it (sidecars this
 * read creates are removed again).
 *
 * @param {string} file
 * @param {'data'|'agent'} kind
 * @returns {{ok: boolean, reason: string|null, message: string|null, sizeBytes: number, tables: Record<string, number>, totalRows: number, migration: number|null, fingerprint: object|null}}
 */
export function inspectBackup(file, kind = 'data') {
  const out = { ok: false, reason: null, message: null, sizeBytes: 0, tables: {}, totalRows: 0, migration: null, fingerprint: null };
  if (!file || !fs.existsSync(file)) { out.reason = 'missing'; out.message = 'backup not found'; return out; }
  let st;
  try { st = fs.statSync(file); } catch { out.reason = 'unreadable'; return out; }
  out.sizeBytes = st.size;
  if (!st.isFile() || st.size === 0) { out.reason = st.size === 0 ? 'empty' : 'not-a-file'; return out; }
  const before = sidecarState(file);
  let db = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
    const quick = db.pragma('quick_check', { simple: true });
    if (quick !== 'ok') { out.reason = 'integrity'; out.message = `quick_check: ${quick}`; return out; }
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') { out.reason = 'integrity'; out.message = `integrity_check: ${ic}`; return out; }
    const names = tableNames(db);
    if (names.length === 0) { out.reason = 'empty-schema'; out.message = 'no tables'; return out; }
    const migration = migrationOf(db, kind);
    if (kind === 'data' && !migration) {
      out.reason = 'not-app-database';
      out.message = 'no applied schema_migrations rows; this is not an LLM-IDE data.db';
      return out;
    }
    if (kind === 'agent' && !names.includes('agent_runs')) {
      out.reason = 'not-agent-database';
      out.message = 'no agent_runs table; this is not an LLM-IDE agent.db';
      return out;
    }
    const fp = fingerprint(db);
    return {
      ...out, ok: true, sizeBytes: st.size, tables: fp.tables,
      totalRows: Object.values(fp.tables).reduce((a, b) => a + b, 0),
      migration, fingerprint: fp,
    };
  } catch (err) {
    out.reason = 'unreadable';
    out.message = err.message;
    return out;
  } finally {
    closeQuietly(db);
    cleanupCreatedSidecars(file, before);
  }
}

/** Refuse while another process has a write transaction on the live file. */
function assertQuiescent(file) {
  if (!fs.existsSync(file)) return;
  let db = null;
  try {
    db = new Database(file, { fileMustExist: true, timeout: 0 });
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
  } catch (err) {
    throw fail('live-in-use', `${path.basename(file)} is in use by another process (${err.code ?? err.message}); stop the server/desktop core first`);
  } finally {
    closeQuietly(db);
  }
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

function verifyFile(file, expected, kind) {
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const ic = db.pragma('integrity_check', { simple: true });
    if (ic !== 'ok') throw fail('verify', `integrity_check on restored ${path.basename(file)}: ${ic}`);
    compareFingerprints(expected.fingerprint, fingerprint(db), `restored ${path.basename(file)}`);
    if (migrationOf(db, kind) !== expected.migration) {
      throw fail('verify', `schema_migrations version changed in restored ${path.basename(file)}`);
    }
  } finally {
    db.close();
  }
}

/** VACUUM INTO a copy of the live file, then verify the copy. */
function snapshotLive(live, target, kind) {
  const db = new Database(live, { fileMustExist: true, timeout: 0 });
  try {
    db.pragma('busy_timeout = 0');
    db.prepare('VACUUM INTO ?').run(target);
  } finally {
    db.close();
  }
  const checked = inspectBackup(target, kind);
  if (!checked.ok) throw fail('verify', `the pre-restore copy of ${path.basename(live)} is not readable: ${checked.message}`);
  return checked;
}

function stageCopy(backup, staged, expected, kind) {
  fs.copyFileSync(backup, staged);
  fsyncPath(staged);
  verifyFile(staged, expected, kind);
}

function planOne({ live, backup, kind, stamp, fault, step }) {
  const checked = inspectBackup(backup, kind);
  if (!checked.ok) {
    throw fail('backup-invalid', `${kind === 'agent' ? 'agent.db' : 'data.db'} backup is not usable: ${checked.message ?? checked.reason}`);
  }
  const plan = {
    live, backup, kind, checked,
    preRestore: fs.existsSync(live) ? `${live}.pre-restore-${stamp}.db` : null,
    staged: `${live}.restore-${stamp}.db`,
    replaced: `${live}.restore-replaced-${stamp}`,
    moved: [],
  };
  if (plan.preRestore) {
    step(`pre-restore:${kind}`);
    snapshotLive(live, plan.preRestore, kind);
  }
  step(`stage:${kind}`);
  stageCopy(backup, plan.staged, checked, kind);
  void fault;
  return plan;
}

function commitOne(plan, step, kind) {
  step(`commit:${kind}`);
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${plan.live}${suffix}`;
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, `${plan.replaced}${suffix}`);
    plan.moved.push(suffix);
  }
  fs.renameSync(plan.staged, plan.live);
  fsyncPath(plan.live);
  fsyncPath(path.dirname(plan.live));
  step(`verify:${kind}`);
  verifyFile(plan.live, plan.checked, kind);
  // The replaced copy is removed only after EVERY plan has verified (see
  // restoreBackup): it is the rollback source for the other half of the pair.
}

function rollbackOne(plan, notes) {
  try {
    for (const suffix of ['', '-wal', '-shm']) removeStrictIfExists(`${plan.live}${suffix}`);
  } catch (err) {
    notes.push(`could not remove the newly restored ${path.basename(plan.live)}: ${err.message}`);
  }
  let restoredAll = true;
  for (const suffix of plan.moved) {
    const from = `${plan.replaced}${suffix}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, `${plan.live}${suffix}`);
    } catch (err) {
      restoredAll = false;
      notes.push(`could not restore ${path.basename(plan.live)}${suffix}: ${err.message}`);
    }
  }
  try { removeStrictIfExists(plan.staged); } catch { /* new copy, safe to drop */ }
  if (restoredAll) {
    try { removeStrictIfExists(plan.replaced); } catch { /* empty after a clean restore */ }
  } else {
    // Never delete the only remaining copy of the old files.
    notes.push(`the previous ${path.basename(plan.live)} files are kept in ${plan.replaced}; restore them by hand`);
  }
  fsyncPath(path.dirname(plan.live));
}

/**
 * Restore a data.db backup, and optionally the agent.db pair. Both are verified
 * before anything live moves. Returns a report; a refusal leaves every live
 * file untouched.
 *
 * @param {object} opts
 * @param {string} opts.backupPath the data.db backup
 * @param {string} [opts.dbPath] live data.db (default config.dbPath)
 * @param {string|null} [opts.agentBackupPath] agent.db backup (optional)
 * @param {string} [opts.agentDbPath] live agent.db (default config.agentDbPath)
 * @param {number} [opts.now] clock (tests)
 * @param {(step: string) => void} [opts.fault] test hook: throws at a step
 * @returns {object} report; `status` is completed | refused | failed
 */
export function restoreBackup({
  backupPath, dbPath = config.dbPath, agentBackupPath = null,
  agentDbPath = config.agentDbPath, now = Date.now(), fault = null,
} = {}) {
  const started = Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const step = (name) => { if (fault) fault(name); };
  const report = {
    status: 'failed',
    reason: null,
    data: null,
    agent: null,
    preRestore: [],
    notes: [],
    durationMs: 0,
  };
  const plans = [];
  try {
    if (!backupPath) throw fail('backup-invalid', 'no --backup was given');
    step('verify-backups');
    const dataChecked = inspectBackup(backupPath, 'data');
    if (!dataChecked.ok) {
      return {
        ...report, status: 'refused', reason: 'backup-invalid',
        notes: [`the data.db backup is not usable: ${dataChecked.message ?? dataChecked.reason}`],
        durationMs: Date.now() - started,
      };
    }
    let agentChecked = null;
    if (agentBackupPath) {
      agentChecked = inspectBackup(agentBackupPath, 'agent');
      if (!agentChecked.ok) {
        return {
          ...report, status: 'refused', reason: 'agent-backup-invalid',
          notes: [`the agent.db backup is not usable: ${agentChecked.message ?? agentChecked.reason}`],
          durationMs: Date.now() - started,
        };
      }
    }
    step('check-live');
    // Verify both live files are quiescent BEFORE writing a pre-restore copy.
    assertQuiescent(dbPath);
    if (agentBackupPath) assertQuiescent(agentDbPath);

    plans.push(planOne({ live: dbPath, backup: backupPath, kind: 'data', stamp, fault, step }));
    if (agentBackupPath) plans.push(planOne({ live: agentDbPath, backup: agentBackupPath, kind: 'agent', stamp, fault, step }));
    for (const p of plans) if (p.preRestore) report.preRestore.push(p.preRestore);

    for (const p of plans) commitOne(p, step, p.kind);
    // Every file verified: the replaced copies are no longer needed (the
    // pre-restore snapshots above still are, and stay).
    for (const p of plans) {
      try { removeStrictIfExists(p.replaced); } catch (e) { report.notes.push(`could not remove ${path.basename(p.replaced)}: ${e.message}`); }
    }
    report.status = 'completed';
    report.data = { path: dbPath, backup: backupPath, rows: dataChecked.totalRows, migration: dataChecked.migration };
    if (agentChecked) report.agent = { path: agentDbPath, backup: agentBackupPath, rows: agentChecked.totalRows, migration: agentChecked.migration };
    return { ...report, durationMs: Date.now() - started };
  } catch (err) {
    const refused = err?.code === 'live-in-use' || err?.code === 'backup-invalid';
    report.status = refused ? 'refused' : 'failed';
    report.reason = err?.code ?? 'restore-failed';
    report.notes.push(err?.message ?? String(err));
    // Roll back every plan that had started, newest first. A plan with no moved
    // files only has a staged copy; dropping that is safe.
    for (const p of plans.slice().reverse()) {
      try { rollbackOne(p, report.notes); } catch (e) { report.notes.push(`rollback of ${path.basename(p.live)} failed: ${e.message}`); }
    }
    // Leave a refused plan's pre-restore copy alone? It was never written on a
    // refusal path. On a failure after pre-restore, it is the safety net.
    return { ...report, durationMs: Date.now() - started };
  }
}
