// SCIP / code-graph node+edge store + traversal. Backs the multi-hop relationship
// queries the code-sync agent uses to ground tasks in compiler-derived symbols.
// Mirrors the db.mjs <-> sources.mjs split: defined here, re-exported from db.mjs.
// Every helper is userId-first (tenancy); writes are transactional.

import path from 'node:path';
import { getDb, requireUser } from './db.mjs';

const DEFAULT_EDGE_KINDS = ['implements', 'references', 'imports'];

/** Upsert CGData { nodes, edges } for a repo. Idempotent (INSERT OR IGNORE). */
export function writeCodeGraph(userId, repoId, cg) {
  requireUser(userId);
  if (!repoId || typeof repoId !== 'string') throw new Error('repoId is required');
  const nodes = (cg && cg.nodes) || [];
  const edges = (cg && cg.edges) || [];
  const db = getDb();
  const upsertNode = db.prepare(
    `INSERT OR IGNORE INTO code_graph_nodes
       (user_id, repo_id, symbol_id, title, kind, source_file, line, language, doc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertEdge = db.prepare(
    `INSERT OR IGNORE INTO code_graph_edges
       (user_id, repo_id, from_id, to_id, kind, confidence)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const n of nodes) {
      const m = n.metadata || {};
      const lineNum = Number(String(m.line || 'L0').replace(/^L/, '')) || 0;
      upsertNode.run(userId, repoId, n.id, n.title || n.id, n.kind || 'symbol',
        m.source_file || '', lineNum, m.language || null, m.doc || null);
    }
    for (const e of edges) {
      upsertEdge.run(userId, repoId, e.fromId, e.toId, e.kind, e.confidence || 'EXTRACTED');
    }
  });
  tx();
  return { nodes: nodes.length, edges: edges.length };
}

/** Delete both graph tables for a repo (used by `replace`). */
export function clearCodeGraph(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM code_graph_nodes WHERE user_id=? AND repo_id=?').run(userId, repoId);
    db.prepare('DELETE FROM code_graph_edges WHERE user_id=? AND repo_id=?').run(userId, repoId);
  });
  tx();
}

/**
 * Delete only SCIP-sourced `sources` rows for a repo — must NOT touch the augment
 * line-chunks. deleteSourcesByPrefix keys on ref-prefix alone and would wipe chunks
 * too, so this is a direct meta-filtered DELETE.
 */
export function deleteScipSources(userId, repoId) {
  requireUser(userId);
  const db = getDb();
  const info = db.prepare(
    `DELETE FROM sources
     WHERE user_id=? AND ref LIKE ? AND meta LIKE '%"source":"scip"%'`,
  ).run(userId, `${repoId}${path.sep}%`);
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

/** Seed symbol ids whose title or doc matches a free-text query. */
export function findCodeSymbolIds(userId, query, limit = 10) {
  requireUser(userId);
  if (!query) return [];
  const like = `%${query}%`;
  const rows = getDb().prepare(
    `SELECT symbol_id FROM code_graph_nodes
     WHERE user_id=? AND (title LIKE ? OR doc LIKE ?)
     LIMIT ?`,
  ).all(userId, like, like, limit);
  return rows.map((r) => r.symbol_id);
}

/** Hydrate symbol ids to node rows for agent context. */
export function hydrateSymbols(userId, symbolIds) {
  requireUser(userId);
  if (!Array.isArray(symbolIds) || symbolIds.length === 0) return [];
  const place = symbolIds.map(() => '?').join(',');
  return getDb().prepare(
    `SELECT symbol_id, title, kind, source_file, line FROM code_graph_nodes
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
