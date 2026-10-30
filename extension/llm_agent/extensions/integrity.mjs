// Content fingerprint of an installed tree (plan section 9a, repair).
//
// The fingerprint is a sha256 over the sorted list of `path NUL sha256(file)`,
// so it does not depend on archive order, timestamps or modes. Install and
// update record it; verify recomputes it from the bytes on disk (offline), and
// repair compares a re-fetch at the pinned commit against it. A commit's bytes
// never change upstream, so a mismatch on a re-fetch is refused, not "fixed".
//
// Reading the disk never follows a link and has the same caps as the archive
// reader, so a tampered directory cannot make a verify run away.

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_LIMITS } from './sources/tar.mjs';

const h = (buf) => createHash('sha256').update(buf).digest('hex');

/** @param {Map<string, Buffer>} files */
export function treeHash(files) {
  const lines = [...files.keys()].sort().map((p) => `${p}\0${h(files.get(p))}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The files under `dir` as Map<relative path, Buffer>, or `{ error }` when the
 * directory is missing, holds a link or special file, or exceeds the caps.
 */
export function readTreeFromDisk(dir) {
  const files = new Map();
  let total = 0;
  const walk = (abs, rel, depth) => {
    if (depth > ARCHIVE_LIMITS.depth) throw new Error('too_deep');
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('link');
      if (st.isDirectory()) { walk(p, r, depth + 1); continue; }
      if (!st.isFile()) throw new Error('special');
      if (st.size > ARCHIVE_LIMITS.fileBytes) throw new Error('too_large');
      total += st.size;
      if (files.size >= ARCHIVE_LIMITS.files || total > ARCHIVE_LIMITS.totalFileBytes) throw new Error('too_large');
      files.set(r, readFileSync(p));
    }
  };
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { error: 'missing' };
    walk(dir, '', 0);
  } catch (err) {
    return { error: err?.code === 'ENOENT' ? 'missing' : String(err?.message ?? 'unreadable').slice(0, 40) };
  }
  return { files };
}

/**
 * Compare the bytes at `dir` with a recorded fingerprint.
 * @returns {{ status: 'ok' | 'corrupt' | 'missing' | 'unverified', hash?: string }}
 *   `unverified`: the bytes are readable but nothing was recorded to compare with
 *   (an item installed before fingerprints existed).
 */
export function verifyDir(dir, recorded) {
  const r = readTreeFromDisk(dir);
  if (r.error) return { status: r.error === 'missing' ? 'missing' : 'corrupt' };
  const hash = treeHash(r.files);
  if (!recorded) return { status: 'unverified', hash };
  return { status: hash === recorded ? 'ok' : 'corrupt', hash };
}

/** File-level diff between two trees (Map<path, Buffer>): added, removed, changed with sizes. */
export function diffTrees(before, after, { limit = 200 } = {}) {
  const added = []; const removed = []; const changed = [];
  for (const [p, b] of after) {
    if (!before.has(p)) added.push({ path: p, size: b.length });
    else if (!before.get(p).equals(b)) changed.push({ path: p, before: before.get(p).length, after: b.length });
  }
  for (const [p, b] of before) if (!after.has(p)) removed.push({ path: p, size: b.length });
  const by = (a, b) => (a.path < b.path ? -1 : 1);
  added.sort(by); removed.sort(by); changed.sort(by);
  const counts = { added: added.length, removed: removed.length, changed: changed.length };
  return { counts, added: added.slice(0, limit), removed: removed.slice(0, limit), changed: changed.slice(0, limit), truncated: Math.max(counts.added, counts.removed, counts.changed) > limit };
}
