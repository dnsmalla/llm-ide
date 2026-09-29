// SCIP / code-graph node+edge store + traversal. Backs the multi-hop relationship
// queries the code-sync agent uses to ground tasks in compiler-derived symbols.
// Mirrors the db.mjs <-> sources.mjs split: defined here, re-exported from db.mjs.
// Every helper is userId-first (tenancy); writes are transactional.

import path from 'node:path';
import os from 'node:os';
import { getDb, requireUser } from './db.mjs';

// `AND repo_id IN (…)` for an optional repo scope. null/[] = unscoped, so every
// existing caller (code-sync, tests) keeps today's behaviour.
function repoScope(repoIds) {
  if (!Array.isArray(repoIds) || repoIds.length === 0) return { sql: '', params: [] };
  return { sql: ` AND repo_id IN (${repoIds.map(() => '?').join(',')})`, params: repoIds };
}

function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

/**
 * The graphed repos that belong to the open workspace. Graph rows carry the
 * INDEXED clone's path as repo_id, and the Mac graphs a project's `code/<child>`
 * repo while the workspace is the project folder, so equality alone would match
 * nothing on the live layout. Two cases:
 *  1. The workspace is at or inside a graphed repo: return ONLY the most
 *     specific such repo (longest resolved path) — a workspace inside a repo
 *     belongs to exactly that repo, even when an outer repo also contains it.
 *  2. Otherwise return every graphed repo under the workspace.
 * Returns null when nothing matches: a different clone must still get answers
 * (find-code already flags such paths `outsideWorkspace`).
 * Known limitation: a parent workspace with several child repos yields all of
 * them; `resolveRepoScope` narrows that using the client's active repo.
 */
export function workspaceRepoIds(userId, workspaceRoot) {
  requireUser(userId);
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) return null;
  const ws = path.resolve(expandHome(workspaceRoot.trim()));
  const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
  const repos = getDb().prepare('SELECT DISTINCT repo_id FROM code_graph_nodes WHERE user_id=?')
    .all(userId)
    .map((r) => ({ id: r.repo_id, abs: path.resolve(expandHome(String(r.repo_id))) }));
  const containing = repos.filter((r) => within(ws, r.abs));
  if (containing.length > 0) {
    containing.sort((x, y) => y.abs.length - x.abs.length);
    return [containing[0].id];
  }
  const under = repos.filter((r) => within(r.abs, ws)).map((r) => r.id);
  return under.length > 0 ? under : null;
}

/**
 * The repo scope for a code-graph read. The open workspace decides the scope;
 * the client's active repo (`agentContext.activeRepoRoot`, the Settings-active
 * clone — a GLOBAL setting that does not follow project switches) may only
 * NARROW it, and only when every repo it resolves to is already inside the
 * workspace scope. This fixes a parent workspace holding several graphed repos
 * without letting a stale Settings clone override the project the user has
 * open. Returns null (unscoped) when the workspace matches nothing.
 */
export function resolveRepoScope(userId, { activeRepoRoot = '', workspaceRoot = '' } = {}) {
  requireUser(userId);
  const ws = workspaceRoot ? workspaceRepoIds(userId, workspaceRoot) : null;
  if (activeRepoRoot && ws) {
    const active = workspaceRepoIds(userId, activeRepoRoot);
    if (active && active.every((id) => ws.includes(id))) return active;
  }
  return ws;
}

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
  repoIds = null,
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
  const scope = repoScope(repoIds);

  for (let hop = 1; hop <= hops; hop++) {
    if (frontier.length === 0 || out.length >= limit) break;
    const place = frontier.map(() => '?').join(',');
    const rows = [];
    if (wantOut) {
      rows.push(...db.prepare(
        `SELECT from_id, to_id AS neighbor_id, kind, confidence, 'out' AS dir FROM code_graph_edges
         WHERE user_id=?${scope.sql} AND from_id IN (${place}) AND kind IN (${kindPlace})`,
      ).all(userId, ...scope.params, ...frontier, ...edgeKinds));
    }
    if (wantIn) {
      rows.push(...db.prepare(
        `SELECT to_id AS from_id, from_id AS neighbor_id, kind, confidence, 'in' AS dir FROM code_graph_edges
         WHERE user_id=?${scope.sql} AND to_id IN (${place}) AND kind IN (${kindPlace})`,
      ).all(userId, ...scope.params, ...frontier, ...edgeKinds));
    }
    const next = [];
    for (const r of rows) {
      if (seen.has(r.neighbor_id)) continue;
      seen.add(r.neighbor_id);
      next.push(r.neighbor_id);
      out.push({
        symbolId: r.neighbor_id,
        viaKind: r.kind,
        confidence: r.confidence,
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
export function searchCodeSymbols(userId, query, limit = 10, { repoIds = null } = {}) {
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
  const scope = repoScope(repoIds);
  return getDb().prepare(
    `SELECT symbol_id, title, kind, repo_id, source_file, line, language, doc,
            CASE
              WHEN lower(title) = ?                     THEN 0
              WHEN title LIKE ? ESCAPE '\\'             THEN 1
              WHEN title LIKE ? ESCAPE '\\'             THEN 2
              ELSE 3
            END AS tier
     FROM code_graph_nodes
     WHERE user_id=?${scope.sql} AND (title LIKE ? ESCAPE '\\' OR doc LIKE ? ESCAPE '\\')
     ORDER BY tier, length(title), title
     LIMIT ?`,
    // Bind order is SQL-text order: the three CASE tiers, then user_id, the
    // optional repo scope, the LIKE pair, and LIMIT.
  ).all(lower, prefix, contains, userId, ...scope.params, contains, contains, limit);
}

function likeContains(term) {
  return `%${String(term).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

/**
 * MULTI-TERM symbol lookup for natural-language questions: the rows that match
 * the most (and the rarest) of `terms` across title and file path, best
 * first. searchCodeSymbols ranks one string; a question's answer usually
 * matches several of its words at once (`rotateInMemory` in `MobilePin.swift`
 * for "mobile pairing PIN rotated") while each word alone matches hundreds of
 * short incidental titles.
 *
 * ONE scan evaluates each term's LIKE set once per row (the per-term CASE sits
 * in a subquery that `LIMIT -1` keeps SQLite from flattening, which would
 * re-evaluate it for every reference) and returns only the rowid, title and
 * per-term field weights of rows that match anything. Document frequency, the
 * rarity weights and the ranking are computed here from those rows — so the
 * cost is one LIKE set per term per row, not one per term per use — and only
 * the top `limit` rows are then fetched in full, by rowid.
 *
 * Per term a row earns the term's weight once, for its best field: title 1,
 * file path 0.6. `doc` is deliberately not matched: it now holds the
 * declaration, which mostly repeats the title, and a LIKE over it was the
 * largest share of the scan's cost for no measured retrieval gain. Returned
 * rows carry `score` and `matched` (how many terms hit) so the caller can
 * re-rank.
 */
export function searchCodeSymbolsByTerms(userId, terms, limit = 40, { repoIds = null } = {}) {
  requireUser(userId);
  const list = (Array.isArray(terms) ? terms : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  if (list.length === 0) return [];
  const likes = list.map(likeContains);
  const scope = repoScope(repoIds);
  const cols = list.map((_, i) =>
    `(CASE WHEN title LIKE ? ESCAPE '\\' THEN 1.0 WHEN source_file LIKE ? ESCAPE '\\' THEN 0.6 ELSE 0 END) AS m${i}`);
  const database = getDb();
  const total = database.prepare(
    `SELECT COUNT(*) AS n FROM code_graph_nodes WHERE user_id=?${scope.sql}`,
  ).get(userId, ...scope.params)?.n || 0;
  const hits = database.prepare(
    `SELECT * FROM (
       SELECT rowid AS rid, title, ${cols.join(', ')}
       FROM code_graph_nodes WHERE user_id=?${scope.sql}
       LIMIT -1
     ) WHERE ${list.map((_, i) => `m${i}`).join(' + ')} > 0`,
    // Bind order is SQL-text order: the per-term CASE pairs, user_id, scope.
  ).all(...likes.flatMap((l) => [l, l]), userId, ...scope.params);
  if (hits.length === 0) return [];

  // Inverse document frequency, floored so a term present everywhere still
  // counts a little toward coverage.
  const df = list.map((_, i) => hits.reduce((n, h) => n + (h[`m${i}`] > 0 ? 1 : 0), 0));
  const weights = df.map((d) => Math.max(0.05, Math.log((total + 1) / (d + 1))));
  const ranked = hits.map((h) => {
    let score = 0;
    let matched = 0;
    list.forEach((_, i) => {
      const m = h[`m${i}`];
      if (m > 0) { score += m * weights[i]; matched += 1; }
    });
    return { rid: h.rid, title: h.title || '', score, matched };
  }).sort((x, y) => (y.score - x.score)
    || (x.title.length - y.title.length)
    || x.title.localeCompare(y.title))
    .slice(0, limit);

  const byRid = new Map(database.prepare(
    `SELECT rowid AS rid, symbol_id, title, kind, repo_id, source_file, line, language, doc
     FROM code_graph_nodes WHERE user_id=? AND rowid IN (${ranked.map(() => '?').join(',')})`,
  ).all(userId, ...ranked.map((r) => r.rid)).map((row) => [row.rid, row]));
  return ranked
    .filter((r) => byRid.has(r.rid))
    .map((r) => {
      const { rid: _rid, ...row } = byRid.get(r.rid);
      return { ...row, score: r.score, matched: r.matched };
    });
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
export function hydrateSymbols(userId, symbolIds, { repoIds = null } = {}) {
  requireUser(userId);
  if (!Array.isArray(symbolIds) || symbolIds.length === 0) return [];
  const place = symbolIds.map(() => '?').join(',');
  const scope = repoScope(repoIds);
  return getDb().prepare(
    `SELECT symbol_id, title, kind, repo_id, source_file, line FROM code_graph_nodes
     WHERE user_id=?${scope.sql} AND symbol_id IN (${place})`,
  ).all(userId, ...scope.params, ...symbolIds);
}

/** Which of `titles` exist as node titles in scope. Capped at 100 names. */
export function existingSymbolTitles(userId, titles, { repoIds = null } = {}) {
  requireUser(userId);
  const list = [...new Set((Array.isArray(titles) ? titles : []).filter((t) => typeof t === 'string' && t))].slice(0, 100);
  if (list.length === 0) return new Set();
  const scope = repoScope(repoIds);
  const rows = getDb().prepare(
    `SELECT DISTINCT title FROM code_graph_nodes
     WHERE user_id=?${scope.sql} AND title IN (${list.map(() => '?').join(',')})`,
  ).all(userId, ...scope.params, ...list);
  return new Set(rows.map((r) => r.title));
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

/** Upsert which commit a repo's graph was generated from (migration 0036). */
export function setCodeGraphMeta(userId, repoId, { commitSha = null, generatedAt = null } = {}) {
  requireUser(userId);
  const sha = typeof commitSha === 'string' && /^[0-9a-f]{7,64}$/i.test(commitSha) ? commitSha : null;
  const at = typeof generatedAt === 'string' ? generatedAt.slice(0, 40) : null;
  getDb().prepare(
    `INSERT INTO code_graph_meta (user_id, repo_id, commit_sha, generated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, repo_id) DO UPDATE SET commit_sha=excluded.commit_sha, generated_at=excluded.generated_at`,
  ).run(userId, repoId, sha, at);
}

export function getCodeGraphMeta(userId, repoIds) {
  requireUser(userId);
  if (!Array.isArray(repoIds) || repoIds.length === 0) return [];
  return getDb().prepare(
    `SELECT repo_id, commit_sha, generated_at FROM code_graph_meta
     WHERE user_id=? AND repo_id IN (${repoIds.map(() => '?').join(',')})`,
  ).all(userId, ...repoIds);
}
