// Retention for the server's own DB backups (data-<unix>.db, written by the
// daily auto backup and POST /admin/backup). Keeps the newest LLMIDE_BACKUP_KEEP
// (default 2, minimum 1) and deletes older ones. It only ever deletes regular
// files whose names match BACKUP_FILE_RE in the directory it was given: nothing
// else in that directory, and nothing in subdirectories, is touched.

import fs from 'fs';
import path from 'path';

export const BACKUP_FILE_RE = /^data-\d+\.db$/;
export const DEFAULT_BACKUP_KEEP = 2;

/**
 * Delete all but the newest `keep` matching backups in `dir` (newest by mtime,
 * then by name). `allowed` is the policy decision from config.backupPrune; when
 * it is false nothing is touched. A directory that holds any other regular file
 * is not this server's backup directory, so it is left alone as well.
 */
export function pruneBackups(dir, keep = DEFAULT_BACKUP_KEEP, { allowed = false, reason = 'not allowed' } = {}) {
  const limit = Math.max(1, Math.floor(keep));
  const result = { kept: [], deleted: [], failed: [], skipped: null };
  if (!allowed) return { ...result, skipped: reason };
  if (!fs.existsSync(dir)) return result;
  const candidates = [];
  const foreign = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    if (!BACKUP_FILE_RE.test(name)) { foreign.push(name); continue; }
    candidates.push({ name, full, mtimeMs: st.mtimeMs });
  }
  if (foreign.length) return { ...result, skipped: `directory holds other files (${foreign.join(', ')}); not pruned` };
  candidates.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.name < b.name ? 1 : -1));
  result.kept = candidates.slice(0, limit).map((c) => c.name);
  for (const old of candidates.slice(limit)) {
    try {
      fs.unlinkSync(old.full);
      result.deleted.push(old.name);
    } catch (err) {
      result.failed.push({ name: old.name, error: err.message });
    }
  }
  return result;
}
