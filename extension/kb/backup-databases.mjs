// The server's own backups are a PAIR: data.db + agent.db. `data.db` is the
// KB/accounts/usage state; `agent.db` is the agent-run history. A restore that
// brings back only the first leaves the Agents hub empty (or worse, a newer
// agent.db pointing at runs the restored DB never made), so every backup path
// goes through here and retention keeps/prunes the pair together.
//
// Both snapshots use SQLite's VACUUM INTO: consistent on a live database, no
// long exclusive lock, and a single clean file (no -wal/-shm to copy).

import fs from 'fs';
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
export function backupDatabasesInWorker(targetPath, { agentDbPath = agentDbFile(), dataDbPath = config.dbPath, includeAgent = true } = {}) {
  const agentTarget = agentBackupPath(targetPath);
  const args = [dataDbPath, targetPath, includeAgent ? agentDbPath : '', includeAgent ? agentTarget : ''];
  return new Promise((resolve, reject) => {
    const child = fork(WORKER, args, {
      execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`backup worker failed (${code ?? 'signal'}): ${stderr.trim().slice(-500)}`));
        return;
      }
      try {
        const agentPath = includeAgent && fs.existsSync(agentTarget) ? agentTarget : null;
        resolve({
          path: targetPath, bytes: fs.statSync(targetPath).size,
          agentPath, agentBytes: agentPath ? fs.statSync(agentPath).size : null,
        });
      } catch (err) { reject(err); }
    });
  });
}
