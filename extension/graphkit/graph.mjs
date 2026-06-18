// Code-graph query API — the one place agents go to ask "which code is
// related to X". Wraps the KB's FTS-backed findContext and applies the
// graph-side hygiene (file-level rollup, traversal-safe refs) that every
// consumer previously re-implemented.

import path from 'node:path';
import { findContext, userRepoAllowlist } from '../kb/db.mjs';

/** Repo allow-list for a user, never throwing — graph queries must not
 *  crash if the allow-list read fails; they just lose absolute refs. */
function safeAllowlist(userId) {
  try { return userRepoAllowlist(userId) || []; }
  catch { return []; }
}

/** True when an absolute ref lives under one of the user's allow-listed
 *  repo roots. `..` is rejected separately, so a prefix test is sound. */
function refUnderAllowedRoot(ref, roots) {
  for (const root of roots) {
    if (!root) continue;
    const base = root.endsWith(path.sep) ? root : root + path.sep;
    if (ref === root || ref.startsWith(base)) return true;
  }
  return false;
}

/**
 * Roll FTS chunk hits up to one entry per file, keeping the best
 * chunk's snippet, and drop refs that look like path-traversal attempts
 * — those could have been introduced by a malicious KB ingest and would
 * otherwise be forwarded to Claude and then to codegen-apply's file
 * reader.
 *
 * Absolute refs (how local-repo code is ingested — `connectors/git.mjs`
 * stores `ref: <absPath>`) are kept ONLY when they live under a repo the
 * user has explicitly added to their allow-list. That restores local-repo
 * code visibility to the agent while still refusing an arbitrary absolute
 * path a malicious KB row might smuggle to codegen's file reader.
 */
export function rollupCodeRefs(rows, allowedRoots = []) {
  const roots = (allowedRoots || []).filter(Boolean);
  const byRef = new Map();
  for (const r of rows || []) {
    const ref = r.ref || r.title?.split(':')[0] || '';
    if (!ref) continue;
    if (ref.includes('..')) continue; // path traversal — always reject
    if (ref.startsWith('/') && !refUnderAllowedRoot(ref, roots)) continue;
    if (!byRef.has(ref)) {
      byRef.set(ref, {
        ref,
        title: r.title,
        bodyExcerpt: (r.body || '').slice(0, 240),
        rank: r.rank,
      });
    }
  }
  return [...byRef.values()];
}

/**
 * Query the code graph for files related to a free-form query.
 * Returns up to `limit` rolled-up file references, best match first.
 */
export function findRelatedCode(userId, query, limit = 5) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return [];
  const ctx = findContext(userId, q, limit * 2);
  return rollupCodeRefs(ctx.code, safeAllowlist(userId)).slice(0, limit);
}

/**
 * Full grounding context (meetings, tasks, code, tickets, blockers)
 * for planners that want more than code refs. Thin passthrough so
 * graph consumers don't import kb/db directly.
 */
export function findGraphContext(userId, query, limit = 5) {
  return findContext(userId, query, limit);
}
