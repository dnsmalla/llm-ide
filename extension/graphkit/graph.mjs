// Code-graph query API — the one place agents go to ask "which code is
// related to X". Wraps the KB's FTS-backed findContext and applies the
// graph-side hygiene (file-level rollup, traversal-safe refs) that every
// consumer previously re-implemented.

import { findContext } from '../kb/db.mjs';

/**
 * Roll FTS chunk hits up to one entry per file, keeping the best
 * chunk's snippet, and drop refs that look like path-traversal attempts
 * — those could have been introduced by a malicious KB ingest and would
 * otherwise be forwarded to Claude and then to codegen-apply's file
 * reader.
 */
export function rollupCodeRefs(rows) {
  const byRef = new Map();
  for (const r of rows || []) {
    const ref = r.ref || r.title?.split(':')[0] || '';
    if (!ref) continue;
    if (ref.includes('..') || ref.startsWith('/')) continue;
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
  return rollupCodeRefs(ctx.code).slice(0, limit);
}

/**
 * Full grounding context (meetings, tasks, code, tickets, blockers)
 * for planners that want more than code refs. Thin passthrough so
 * graph consumers don't import kb/db directly.
 */
export function findGraphContext(userId, query, limit = 5) {
  return findContext(userId, query, limit);
}
