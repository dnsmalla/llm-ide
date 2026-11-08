// The server's own backups are a PAIR: data.db + agent.db. `data.db` is the
// KB/accounts/usage state; `agent.db` is the agent-run history. A restore that
// brings back only the first leaves the Agents hub empty (or worse, a newer
// agent.db pointing at runs the restored DB never made), so every backup path
// goes through here and retention keeps/prunes the pair together.
//
// Both snapshots use SQLite's VACUUM INTO: consistent on a live database, no
// long exclusive lock, and a single clean file (no -wal/-shm to copy).

import fs from 'fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backupTo } from './db.mjs';
import { backupAgentTo, agentDbFile } from './agent-db.mjs';
import { config } from '../core/config.mjs';

const WORKER = fileURLToPath(new URL('./backup-worker.mjs', import.meta.url));

/** `backups/data-<stamp>.db` -> `backups/data-<stamp>.agent.db` (same directory). */
export function agentBackupPath(targetPath) {
  const p = String(targetPath);
  return p.endsWith('.db') ? `${p.slice(0, -3)}.agent.db` : `${p}.agent.db`;
}

/**
 * Snapshot data.db and, when it exists, agent.db beside it.
 *
 * @param {string} targetPath the data.db backup file (must not exist yet)
 * @param {{agentDbPath?: string, includeAgent?: boolean}} [opts]
 * @returns {{path: string, bytes: number, agentPath: string|null, agentBytes: number|null}}
 */
export function backupDatabasesTo(targetPath, { agentDbPath = agentDbFile(), includeAgent = true } = {}) {
  backupTo(targetPath);
  let agentPath = null;
  let agentBytes = null;
  if (includeAgent && fs.existsSync(agentDbPath)) {
    agentPath = agentBackupPath(targetPath);
    backupAgentTo(agentPath);
    agentBytes = fs.statSync(agentPath).size;
  }
  return { path: targetPath, bytes: fs.statSync(targetPath).size, agentPath, agentBytes };
}

/**
 * Snapshot data.db (and agent.db when it exists) in a forked child process, so the synchronous VACUUM INTO never
 * blocks the server's event loop. Resolves with the same shape as `backupDatabasesTo`; rejects when the worker
 * fails, so a caller never treats a missing snapshot as success. The child gets a minimal env: no secrets.
 */
/** Where a snapshot is written before it is complete: retention and the off-host script only see final names. */
export const INFLIGHT_DIR = '.inflight';
/** A worker that hangs (a stuck disk, WAL recovery) is killed rather than holding the route open forever. */
export const BACKUP_WORKER_TIMEOUT_MS = 10 * 60_000;
const inflight = new Set();

/** Kill every running backup worker (shutdown). Their in-flight staging files are removed by the exit handler. */
export function killBackupWorkers() {
  for (const child of inflight) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

export function backupDatabasesInWorker(targetPath, { agentDbPath = agentDbFile(), dataDbPath = config.dbPath, includeAgent = true } = {}) {
  const agentTarget = agentBackupPath(targetPath);
  const dir = path.dirname(targetPath);
  const stagingDir = path.join(dir, INFLIGHT_DIR);
  const stagedData = path.join(stagingDir, path.basename(targetPath));
  const stagedAgent = path.join(stagingDir, path.basename(agentTarget));
  const args = [dataDbPath, stagedData, includeAgent ? agentDbPath : '', includeAgent ? stagedAgent : ''];
  return new Promise((resolve, reject) => {
    const cleanupStaging = () => {
      // A killed VACUUM INTO can leave SQLite sidecars beside the partial file.
      for (const base of [stagedData, stagedAgent]) {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          try { fs.rmSync(`${base}${suffix}`, { force: true }); } catch { /* best effort */ }
        }
      }
    };
    try { fs.mkdirSync(stagingDir, { recursive: true }); } catch (err) { reject(err); return; }
    const child = fork(WORKER, args, {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
    });
    inflight.add(child);
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      inflight.delete(child);
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, BACKUP_WORKER_TIMEOUT_MS);
    timer.unref?.();
    child.stderr?.on('data', (d) => { stderr += d; });
    child.once('error', (err) => { cleanupStaging(); finish(reject, err); });
    child.once('exit', (code) => {
      if (code !== 0) {
        // A crash, a stop, or the timeout: never leave a partial snapshot behind for retention to keep.
        cleanupStaging();
        finish(reject, new Error(`backup worker failed (${code ?? 'signal'}): ${stderr.trim().slice(-500)}`));
        return;
      }
      try {
        // agent first, data last: a final data-<stamp>.db always has its pair.
        const agentPath = includeAgent && fs.existsSync(stagedAgent) ? agentTarget : null;
        if (agentPath) fs.renameSync(stagedAgent, agentTarget);
        fs.renameSync(stagedData, targetPath);
        resolve({
          path: targetPath, bytes: fs.statSync(targetPath).size,
          agentPath, agentBytes: agentPath ? fs.statSync(agentPath).size : null,
        });
        finish(() => {});
      } catch (err) {
        cleanupStaging();
        try { fs.rmSync(agentTarget, { force: true }); } catch { /* best effort */ }
        finish(reject, err);
      }
    });
  });
}
