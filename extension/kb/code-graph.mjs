// SCIP / code-graph node+edge store + traversal. Backs the multi-hop relationship
// queries the code-sync agent uses to ground tasks in compiler-derived symbols.
// Mirrors the db.mjs <-> sources.mjs split: defined here, re-exported from db.mjs.
// Every helper is userId-first (tenancy); writes are transactional.

import path from 'node:path';
import { getDb, requireUser } from './db.mjs';

// Edge kinds traversed by expandSymbols. The first three are everything the
// SCIP parser emits, so its behaviour is unchanged; `calls` and `inherits`
// exist only in the structural graph, where they are the natural symbol→symbol
// hops ("what does this function reach", "what is this class a kind of").
// `contains` is deliberately excluded HERE: it is file→symbol, so one file seed
// would flood the (post-expand, pre-rank) result with every symbol that file
// declares and crowd out genuinely related code. graphNeighbors lets a caller
// opt into it per-seed instead (see CONTAINS_EDGE_KIND).
const DEFAULT_EDGE_KINDS = ['implements', 'references', 'imports', 'calls', 'inherits'];

// The file→symbol edge. Excluded from DEFAULT_EDGE_KINDS for the reason above,
// but the RIGHT hop when the seed is a file node — "what does this file declare"
// is exactly what a code-search caller wants there.
export const CONTAINS_EDGE_KIND = 'contains';

// Per-hop frontier ceiling for graphNeighbors. Each hop binds the frontier as
// SQL parameters, and a hub symbol (imported by 101 modules, as `db.mjs` is
// here) can otherwise blow past SQLite's variable limit AND swamp the result
// with low-signal neighbours. Bounded per hop, not per traversal, so hop 2
// still starts from a full — if truncated — hop-1 set.
const MAX_FRONTIER = 200;

// Graph producers (the `source` column, migration 0027). Each replaces only its
// OWN rows, so a Mac-app regeneration can't wipe a SCIP index and vice versa.
export const GRAPH_SOURCE_SCIP = 'scip';
export const GRAPH_SOURCE_STRUCTURE = 'structure';
const KNOWN_GRAPH_SOURCES = new Set([GRAPH_SOURCE_SCIP, GRAPH_SOURCE_STRUCTURE]);

function requireGraphSource(source) {
  if (!KNOWN_GRAPH_SOURCES.has(source)) throw new Error(`unknown graph source: ${source}`);
  return source;
}

/**
 * Upsert CGData { nodes, edges } for a repo. Idempotent (INSERT OR IGNORE).
 * `source` tags provenance so each producer can replace only its own rows.
 */
export function writeCodeGraph(userId, repoId, cg, { source = GRAPH_SOURCE_SCIP } = {}) {
  requireUser(userId);
  if (!repoId || typeof repoId !== 'string') throw new Error('repoId is required');
  requireGraphSource(source);
  const nodes = (cg && cg.nodes) || [];
  const edges = (cg && cg.edges) || [];
  const db = getDb();
  const upsertNode = db.prepare(
    `INSERT OR IGNORE INTO code_graph_nodes
       (user_id, repo_id, symbol_id, title, kind, source_file, line, language, doc, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertEdge = db.prepare(
    `INSERT OR IGNORE INTO code_graph_edges
       (user_id, repo_id, from_id, to_id, kind, confidence, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const n of nodes) {
      const m = n.metadata || {};
      const lineNum = Number(String(m.line || 'L0').replace(/^L/, '')) || 0;
      upsertNode.run(userId, repoId, n.id, n.title || n.id, n.kind || 'symbol',
        m.source_file || '', lineNum, m.language || null, m.doc || null, source);
    }
    for (const e of edges) {
      upsertEdge.run(userId, repoId, e.fromId, e.toId, e.kind, e.confidence || 'EXTRACTED', source);
    }
  });
  tx();
  return { nodes: nodes.length, edges: edges.length };
}

/**
 * Delete graph rows for a repo (used by `replace`). Scoped to one producer's
 * `source` — passing null clears EVERY source for the repo, which only a
 * whole-repo teardown should do.
 */
export function clearCodeGraph(userId, repoId, { source = GRAPH_SOURCE_SCIP } = {}) {
  requireUser(userId);
  if (source !== null) requireGraphSource(source);
  const db = getDb();
  const where = source === null ? '' : ' AND source=?';
  const args = source === null ? [userId, repoId] : [userId, repoId, source];
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM code_graph_nodes WHERE user_id=? AND repo_id=?${where}`).run(...args);
    db.prepare(`DELETE FROM code_graph_edges WHERE user_id=? AND repo_id=?${where}`).run(...args);
  });
  tx();
}

/**
 * Delete only SCIP-sourced `sources` rows for a repo — must NOT touch the augment
 * line-chunks. deleteSourcesByPrefix keys on ref-prefix alone and would wipe chunks
 * too, so this is a direct meta-filtered DELETE.
 *
 * LIKE wildcards in repoId are escaped so a literal `_` in a repo path (e.g.
 * /x/my_repo/) doesn't match ANY character and take out a sibling repo's rows
 * (e.g. /x/myXrepo/) — same fix as deleteSourcesByPrefix in sources.mjs.
 */
export function deleteScipSources(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  const escaped = String(repoId).replace(/[\\%_]/g, (c) => `\\${c}`);
  const info = db.prepare(
    `DELETE FROM sources
     WHERE user_id=? AND ref LIKE ? ESCAPE '\\' AND meta LIKE '%"source":"scip"%'`,
  ).run(userId, `${escaped}${path.sep}%`);
  return info.changes;
}

/** Multi-hop BFS over code_graph_edges from seed symbol ids (user-scoped). */
export function expandSymbols(userId, seedIds, { hops = 1, edgeKinds = DEFAULT_EDGE_KINDS } = {}) {
  requireUser(userId);
  if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
  const db = getDb();
  const seen = new Set(seedIds);
  const out = [];
  let frontier = [...new Set(seedIds)];
  const kindPlace = edgeKinds.map(() => '?').join(',');
  for (let h = 0; h < hops; h++) {
    if (frontier.length === 0) break;
    const fromPlace = frontier.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT to_id FROM code_graph_edges
       WHERE user_id=? AND from_id IN (${fromPlace}) AND kind IN (${kindPlace})`,
    ).all(userId, ...frontier, ...edgeKinds);
    const next = [];
    for (const r of rows) {
      if (!seen.has(r.to_id)) { seen.add(r.to_id); next.push(r.to_id); out.push(r.to_id); }
    }
    frontier = next;
  }
  return out;
}

/**
 * Like expandSymbols, but BIDIRECTIONAL and edge-labelled — the traversal a
 * code-search tool needs.
 *
 * expandSymbols only follows `from_id → to_id`, so it answers "what does this
 * symbol reach" and can never answer "who calls / references / imports THIS",
 * which is the more useful direction when you're fixing a bug in a symbol. This
 * walks both directions and reports, for every neighbour, the edge kind and
 * which way it pointed — so a caller can tell the agent *why* a symbol is
 * related ("called by X") instead of dumping an unexplained id list.
 *
 * Kept as a separate function rather than an option on expandSymbols so the
 * code-sync agent's grounding behaviour is untouched.
 *
 * @param direction 'both' (default) | 'out' (this → others) | 'in' (others → this)
 * @returns [{ symbolId, viaKind, direction, hop, fromId }] — seeds excluded,
 *          deduped by symbolId keeping the shortest hop (first BFS win).
 */
export function graphNeighbors(userId, seedIds, {
  hops = 1,
  edgeKinds = DEFAULT_EDGE_KINDS,
  direction = 'both',
  limit = 60,
} = {}) {
  requireUser(userId);
  if (!Array.isArray(seedIds) || seedIds.length === 0) return [];
  if (!Array.isArray(edgeKinds) || edgeKinds.length === 0) return [];
  const db = getDb();
  const wantOut = direction === 'both' || direction === 'out';
  const wantIn = direction === 'both' || direction === 'in';
  const seen = new Set(seedIds);
  const out = [];
  let frontier = [...new Set(seedIds)].slice(0, MAX_FRONTIER);
  const kindPlace = edgeKinds.map(() => '?').join(',');

  for (let hop = 1; hop <= hops; hop++) {
    if (frontier.length === 0 || out.length >= limit) break;
    const place = frontier.map(() => '?').join(',');
    const rows = [];
    if (wantOut) {
      rows.push(...db.prepare(
        `SELECT from_id, to_id AS neighbor_id, kind, 'out' AS dir FROM code_graph_edges
         WHERE user_id=? AND from_id IN (${place}) AND kind IN (${kindPlace})`,
      ).all(userId, ...frontier, ...edgeKinds));
    }
    if (wantIn) {
      rows.push(...db.prepare(
        `SELECT to_id AS from_id, from_id AS neighbor_id, kind, 'in' AS dir FROM code_graph_edges
         WHERE user_id=? AND to_id IN (${place}) AND kind IN (${kindPlace})`,
      ).all(userId, ...frontier, ...edgeKinds));
    }
    const next = [];
    for (const r of rows) {
      if (seen.has(r.neighbor_id)) continue;
      seen.add(r.neighbor_id);
      next.push(r.neighbor_id);
      out.push({
        symbolId: r.neighbor_id,
        viaKind: r.kind,
        direction: r.dir,
        hop,
        fromId: r.from_id,
      });
      if (out.length >= limit) break;
    }
    frontier = next.slice(0, MAX_FRONTIER);
  }
  return out;
}

// TODO scale: findCodeSymbolIds uses a leading-% LIKE on code_graph_nodes, which
// can't use the (user_id, title) index and scans the table per token. For large
// indexes, seeding should query the FTS5 `sources` table (where meta.source='scip'
// + meta.symbol_id already live) instead of scanning code_graph_nodes.
/**
 * Seed symbol ids whose title or doc matches a free-text query. LIKE wildcards
 * (`%` `_` `\`) in the query are escaped so a literal underscore in a symbol
 * name (e.g. `my_func`) doesn't match every character.
 */
export function findCodeSymbolIds(userId, query, limit = 10) {
  requireUser(userId);
  if (!query) return [];
  const escaped = String(query)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const like = `%${escaped}%`;
  const rows = getDb().prepare(
    `SELECT symbol_id FROM code_graph_nodes
     WHERE user_id=? AND (title LIKE ? ESCAPE '\\' OR doc LIKE ? ESCAPE '\\')
     LIMIT ?`,
  ).all(userId, like, like, limit);
  return rows.map((r) => r.symbol_id);
}

/**
 * RANKED symbol lookup: full node rows for the symbols whose title best matches
 * `query`, best first. This is the index half of the index→graph search the
 * agent's find-code tool performs.
 *
 * Why not findCodeSymbolIds: that one returns bare ids with `LIMIT` and NO
 * `ORDER BY`, so which rows come back is whatever SQLite scans first — for a
 * query like "read" that means arbitrary symbols, and the caller then needs a
 * second hydrate round-trip. Here the match tier is computed in SQL (exact
 * title > prefix > substring > doc-only) and the shorter title wins inside a
 * tier, so `find-code "graphNeighbors"` puts the actual definition on top
 * instead of burying it under longer incidental matches.
 *
 * Same LIKE-escaping contract as findCodeSymbolIds; same scan-cost caveat as
 * the TODO above.
 */
export function searchCodeSymbols(userId, query, limit = 10) {
  requireUser(userId);
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return [];
  const escaped = q
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const contains = `%${escaped}%`;
  const prefix = `${escaped}%`;
  const lower = q.toLowerCase();
  return getDb().prepare(
    `SELECT symbol_id, title, kind, repo_id, source_file, line, language, doc,
            CASE
              WHEN lower(title) = ?                     THEN 0
              WHEN title LIKE ? ESCAPE '\\'             THEN 1
              WHEN title LIKE ? ESCAPE '\\'             THEN 2
              ELSE 3
            END AS tier
     FROM code_graph_nodes
     WHERE user_id=? AND (title LIKE ? ESCAPE '\\' OR doc LIKE ? ESCAPE '\\')
     ORDER BY tier, length(title), title
     LIMIT ?`,
    // Bind order is SQL-text order: the three CASE tiers in the SELECT come
    // before the WHERE clause's user_id + LIKE pair.
  ).all(lower, prefix, contains, userId, contains, contains, limit);
}

/**
 * Whether this user has ANY code-graph rows — i.e. whether a graph has ever
 * been generated for them.
 *
 * Deliberately query-independent: callers need to tell "the index has nothing
 * matching THIS query" from "there is no index on this install", and those
 * demand opposite advice (refine the query vs go generate the graph). Inferring
 * it from an empty result set conflates the two and tells users with a perfectly
 * good index that they don't have one. `LIMIT 1` on an indexed column, so it
 * costs nothing to ask on every search.
 */
export function hasCodeGraph(userId) {
  requireUser(userId);
  return getDb().prepare(
    'SELECT 1 FROM code_graph_nodes WHERE user_id=? LIMIT 1',
  ).get(userId) !== undefined;
}

/**
 * Hydrate symbol ids to node rows for agent context. Includes repo_id
 * (alongside the relative source_file) so callers can resolve the absolute
 * on-disk path — e.g. codegen.mjs uses it to confirm which FTS-matched file
 * a task's compiler-derived symbols actually touch.
 */
export function hydrateSymbols(userId, symbolIds) {
  requireUser(userId);
  if (!Array.isArray(symbolIds) || symbolIds.length === 0) return [];
  const place = symbolIds.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT symbol_id, title, kind, repo_id, source_file, line FROM code_graph_nodes
     WHERE user_id=? AND symbol_id IN (${place})`,
  ).all(userId, ...symbolIds);
}

/** All nodes/edges for a repo (verification / future Mac read). */
export function getCodeGraphSnapshot(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  return {
    nodes: db.prepare(
      'SELECT symbol_id, title, kind, source_file, line, language, doc FROM code_graph_nodes WHERE user_id=? AND repo_id=?',
    ).all(userId, repoId),
    edges: db.prepare(
      'SELECT from_id, to_id, kind, confidence FROM code_graph_edges WHERE user_id=? AND repo_id=?',
    ).all(userId, repoId),
  };
}
