// One spelling per directory on a case-insensitive filesystem.
//
// macOS (APFS default) and Windows treat `~/Desktop/LLM` and `~/Desktop/llm`
// as the same folder, but a path used as a database key does not — the same
// clone graphed under both spellings ended up as two repos. This returns the
// on-disk spelling, and ONLY when the difference is letter case: a symlink or
// `..` is left as the caller spelled it, because callers that key on a path
// (allow-lists, repo ids) have deliberately not resolved symlinks so far.

import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * @param {string} p a path (resolved against cwd if relative)
 * @returns {string} the resolved path, re-spelled in its on-disk letter case
 *   when it differs from that only by case; otherwise the resolved path. A
 *   path that does not exist keeps its own tail under a re-spelled ancestor.
 */
export function canonicalPathCase(p) {
  const abs = path.resolve(p);
  let real;
  try {
    real = realpathSync.native(abs);
  } catch {
    // Not on disk (yet): re-spell the nearest existing ancestor, keep the rest.
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonicalPathCase(parent), path.basename(abs));
  }
  return real !== abs && real.toLowerCase() === abs.toLowerCase() ? real : abs;
}
