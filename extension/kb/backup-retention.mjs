// Retention for the server's own DB backups (data-<unix>.db, written by the
// daily auto backup and POST /admin/backup). Keeps the newest LLMIDE_BACKUP_KEEP
// (default 2, minimum 1) and deletes older ones. It only ever deletes regular
// files whose names match BACKUP_FILE_RE in the directory it was given: nothing
// else in that directory, and nothing in subdirectories, is touched.

import fs from 'fs';
import path from 'path';

// A backup is a PAIR: data-<unix>.db and data-<unix>.agent.db. Old backups
// (before agent.db was included) have only the first file; both shapes match.
export const BACKUP_FILE_RE = /^data-(\d+)(\.agent)?\.db$/;
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
  // Group by the unix stamp so a data.db and its agent.db are kept or deleted
  // together. A directory with an orphaned second file is still one group.
  const groups = new Map();
  const foreign = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    const m = name.match(BACKUP_FILE_RE);
    if (!m) { foreign.push(name); continue; }
    const stamp = m[1];
    const g = groups.get(stamp) ?? { stamp, files: [], mtimeMs: 0 };
    g.files.push({ name, full });
    g.mtimeMs = Math.max(g.mtimeMs, st.mtimeMs);
    groups.set(stamp, g);
  }
  if (foreign.length) return { ...result, skipped: `directory holds other files (${foreign.join(', ')}); not pruned` };
  const ordered = [...groups.values()].sort((a, b) => (b.mtimeMs - a.mtimeMs) || (Number(b.stamp) - Number(a.stamp)));
  const kept = ordered.slice(0, limit);
  result.kept = kept.flatMap((g) => g.files.map((f) => f.name)).sort();
  for (const old of ordered.slice(limit)) {
    for (const f of old.files) {
      try {
        fs.unlinkSync(f.full);
        result.deleted.push(f.name);
      } catch (err) {
        result.failed.push({ name: f.name, error: err.message });
      }
    }
  }
  return result;
}
