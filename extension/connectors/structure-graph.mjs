// Structural code-graph ingest — the server half of the Mac app's knowledge
// pipeline.
//
// The Mac app already builds a full symbol graph for every project it graphs
// (GraphKit's StructureGraphBuilder: file + symbol nodes, contains/imports/
// inherits/implements/calls edges) and writes it to `<repo>/system/graph/`. That
// graph never reached the server, so `code_graph_nodes` stayed empty for every
// install — `/kb/ingest-scip` is the only other writer and it requires a
// hand-produced SCIP index, which nothing in the product generates. The result
// was that `findRelatedSymbols` (graphkit/graph.mjs), and therefore the
// compiler-derived half of the code-sync agent's grounding, always returned [].
// This module closes that gap: the Mac POSTs its CGData to
// /kb/ingest-code-graph after each generation and it lands in the same tables
// the SCIP path writes, tagged `source='structure'` (migration 0027) so the two
// producers replace only their own rows.
//
// Unlike indexScip this writes ONLY the graph tables — no `sources` rows. The
// git connector already indexes the same repo's file contents for FTS, and
// adding a second symbol-level row per file would duplicate hits inside
// findRelatedCode's per-file rollup.

import path from 'node:path';
import { getDb } from '../kb/db.mjs';
import { writeCodeGraph, clearCodeGraph, GRAPH_SOURCE_STRUCTURE } from '../kb/code-graph.mjs';

// Per-request ceilings. The Mac client batches, so these bound ONE batch, not a
// repo — a graph larger than this arrives across several calls. Sized well under
// the 8 MB body limit for a typical node/edge payload.
export const MAX_NODES_PER_REQUEST = 5000;
export const MAX_EDGES_PER_REQUEST = 20000;

const MAX_ID_CHARS = 512;
const MAX_TITLE_CHARS = 256;
const MAX_DOC_CHARS = 2000;

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Normalise one client-supplied node. Returns null when it can't be stored.
 *
 * `source_file` is forced to a repo-relative path with no `..` segment: it is
 * echoed back to agents by hydrateSymbols and joined against repo_id to build an
 * absolute path, so a hostile or buggy client must not be able to smuggle a
 * traversal or an absolute path through it.
 */
export function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id, MAX_ID_CHARS);
  if (!id) return null;
  const m = (raw.metadata && typeof raw.metadata === 'object') ? raw.metadata : {};
  let sourceFile = str(m.source_file, MAX_ID_CHARS).replace(/\\/g, '/');
  if (path.isAbsolute(sourceFile) || sourceFile.split('/').includes('..')) sourceFile = '';
  return {
    id,
    title: str(raw.title, MAX_TITLE_CHARS) || id,
    kind: str(raw.kind, 64) || 'symbol',
    metadata: {
      source_file: sourceFile,
      // writeCodeGraph parses "L12"; accept a bare number too.
      line: `L${String(m.line ?? '').replace(/^L/, '').replace(/\D/g, '') || '0'}`,
      language: str(m.language, 64),
      doc: str(m.doc, MAX_DOC_CHARS),
    },
  };
}

/** Normalise one edge. Returns null when either endpoint or the kind is absent. */
export function normalizeEdge(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fromId = str(raw.fromId, MAX_ID_CHARS);
  const toId = str(raw.toId, MAX_ID_CHARS);
  const kind = str(raw.kind, 64);
  if (!fromId || !toId || !kind) return null;
  return { fromId, toId, kind, confidence: str(raw.confidence, 32) || 'EXTRACTED' };
}

/**
 * Write one batch of a repo's structural graph.
 *
 * `replace` clears this producer's existing rows for the repo first — the Mac
 * client sets it on the FIRST batch only, so a multi-batch upload replaces the
 * previous generation exactly once instead of wiping its own earlier batches.
 *
 * Caller MUST have already gated `repoPath` against the user's repo allow-list.
 * Returns counts of what was actually stored (post-normalisation), plus how many
 * malformed entries were dropped, so a client can tell a partial write from a
 * clean one instead of assuming success.
 */
export function ingestStructureGraph(userId, repoPath, graph, opts = {}) {
  const repoId = path.resolve(repoPath);
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  if (rawNodes.length > MAX_NODES_PER_REQUEST) {
    throw new Error(`too many nodes in one request (${rawNodes.length} > ${MAX_NODES_PER_REQUEST})`);
  }
  if (rawEdges.length > MAX_EDGES_PER_REQUEST) {
    throw new Error(`too many edges in one request (${rawEdges.length} > ${MAX_EDGES_PER_REQUEST})`);
  }

  const nodes = rawNodes.map(normalizeNode).filter(Boolean);
  const edges = rawEdges.map(normalizeEdge).filter(Boolean);
  const replace = opts.replace === true;

  // One transaction over the clear + write so a mid-write failure can't leave
  // the repo with its previous graph deleted and no replacement.
  return getDb().transaction(() => {
    if (replace) clearCodeGraph(userId, repoId, { source: GRAPH_SOURCE_STRUCTURE });
    const written = writeCodeGraph(userId, repoId, { nodes, edges },
      { source: GRAPH_SOURCE_STRUCTURE });
    return {
      repo: repoId,
      nodes: written.nodes,
      edges: written.edges,
      droppedNodes: rawNodes.length - nodes.length,
      droppedEdges: rawEdges.length - edges.length,
      replaced: replace,
    };
  })();
}
