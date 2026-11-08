// The server's own backups are a PAIR: data.db + agent.db. `data.db` is the
// KB/accounts/usage state; `agent.db` is the agent-run history. A restore that
// brings back only the first leaves the Agents hub empty (or worse, a newer
// agent.db pointing at runs the restored DB never made), so every backup path
// goes through here and retention keeps/prunes the pair together.
//
// Both snapshots use SQLite's VACUUM INTO: consistent on a live database, no
// long exclusive lock, and a single clean file (no -wal/-shm to copy).

import fs from 'fs';
import { backupTo } from './db.mjs';
import { backupAgentTo, agentDbFile } from './agent-db.mjs';

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
