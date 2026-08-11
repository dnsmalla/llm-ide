// SCIP / code-graph node+edge store + traversal. Backs the multi-hop relationship
// queries the code-sync agent uses to ground tasks in compiler-derived symbols.
// Mirrors the db.mjs <-> sources.mjs split: defined here, re-exported from db.mjs.
// Every helper is userId-first (tenancy); writes are transactional.

import path from 'node:path';
import { getDb, requireUser } from './db.mjs';

// Edge kinds traversed by expandSymbols. The first three are everything the
// SCIP parser emits, so its behaviour is unchanged; `calls` exists only in the
// structural graph, where it is the natural symbol→symbol hop ("what does this
// function reach"). `contains` is deliberately excluded: it is file→symbol, so
// one file seed would flood the (post-expand, pre-rank) result with every
// symbol that file declares and crowd out genuinely related code.
const DEFAULT_EDGE_KINDS = ['implements', 'references', 'imports', 'calls'];

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
