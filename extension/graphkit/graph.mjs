// Code-graph query API — the one place agents go to ask "which code is
// related to X". Wraps the KB's FTS-backed findContext and applies the
// graph-side hygiene (file-level rollup, traversal-safe refs) that every
// consumer previously re-implemented.

import path from 'node:path';
import { findContext, userRepoAllowlist, findCodeSymbolIds, expandSymbols, hydrateSymbols } from '../kb/db.mjs';

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

// Stop-words filtered from multi-word task-title tokens before graph seeding.
// These are common English filler / generic dev words that, if probed first,
// would fill the seed cap before a meaningful token (e.g. "Button") is tried.
const SEED_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by',
  'with', 'fix', 'component', 'this', 'that',
]);

/**
 * Compiler-derived symbol grounding for a free-text query. Seeds from symbol
 * titles/docs that match the query, expands `hops` over the code graph
 * (implements/references/imports), and hydrates to located symbols. Returns []
 * when no SCIP graph is present, so callers (code-sync) degrade gracefully.
 *
 * Seeding is token-aware: a free-text task query like "Fix the Button
 * component" is split on whitespace and each token is probed (plus the whole
 * query, to preserve exact-phrase matches). findCodeSymbolIds uses a single
 * substring LIKE, so a raw multi-word query would otherwise miss a symbol
 * titled just "Button". Tokens are filtered to length ≥ 3, de-stop-worded,
 * and probed longest-first so specific tokens (e.g. "Authentication") win
 * before generic ones (e.g. "handler") fill the seed cap.
 */
export function findRelatedSymbols(userId, query, { hops = 1, limit = 10 } = {}) {
  if (!query) return [];
  const tokens = String(query)
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !SEED_STOP_WORDS.has(t.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  const candidates = [...new Set([query, ...tokens])];
  const seedSet = new Set();
  for (const q of candidates) {
    for (const id of findCodeSymbolIds(userId, q, limit)) seedSet.add(id);
    if (seedSet.size >= limit) break;
  }
  const seeds = [...seedSet].slice(0, limit);
  if (seeds.length === 0) return [];
  const expanded = expandSymbols(userId, seeds, { hops });
  const ids = [...new Set([...seeds, ...expanded])];
  // Cap the hydrated result so a hub seed (one symbol referenced by many) can't
  // blow past `limit` after expand.
  return hydrateSymbols(userId, ids).slice(0, limit);
}
