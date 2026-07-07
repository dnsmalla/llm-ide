// GraphService: high-level graph operations.
//
// Phase 2 service layer. Reads/writes flow through the Phase 1 storage layer
// (storage/graph-storage.ts). Reads degrade gracefully (never throw); writes
// surface failures so callers can react. Full graph generation and FTS-backed
// related-code search are deferred to later phases — for now generateGraph
// returns any existing graph (or empty) and findRelatedCode returns an empty
// list, which preserves current behavior without crashing.
//
// NOTE on brief drift: the task brief referenced `node.label` and a `mode`
// field on GraphData, and imported `rollupCodeRefs`/`renderRepoMemory` from
// graph.mjs. None of those match the shipped Phase 1 surface:
//   - GraphNode uses `title` (not `label`); querying on `label` would never
//     match real nodes, so this implementation searches `title`.
//   - GraphData is `{ nodes, edges }` with no `mode` field, so none is emitted
//     on returned objects (the `mode` parameter is still accepted on
//     generateGraph for API stability / future use).
//   - graph.mjs does not export `renderRepoMemory`, and `rollupCodeRefs` is not
//     used by the stubbed findRelatedCode; importing a non-existent named
//     binding would crash the module at load time, so no graph.mjs import is
//     taken here. Delegation will be wired in a later phase alongside FTS.

import {
  readGraphFile,
  writeDocFingerprint
} from '../storage/graph-storage.ts';
import type { GraphData, GraphNode, GraphMode, CodeRef } from '../types/graph.ts';

/**
 * GraphService provides high-level graph operations.
 *
 * Initially delegates to the storage layer for parity; richer generation and
 * FTS search arrive in later phases.
 */
export class GraphService {
  /**
   * Generate graph for a repo in the specified mode.
   *
   * For now this returns any existing graph on disk, or an empty graph for a
   * fresh repo. Full generation lands in a later phase.
   */
  async generateGraph(repoRoot: URL, mode: GraphMode = 'code'): Promise<GraphData> {
    try {
      const existing = await readGraphFile(repoRoot);
      if (existing.nodes.length > 0 || existing.edges.length > 0) {
        return existing;
      }
      return { nodes: [], edges: [] };
    } catch (err) {
      // Graceful degradation — never crash the agent.
      console.error(`Graph generation failed (mode=${mode}):`, err);
      return { nodes: [], edges: [] };
    }
  }

  /**
   * Query graph for nodes whose title contains the query string
   * (case-insensitive). Returns up to `limit` matches.
   */
  async queryGraph(repoRoot: URL, query: string, limit = 10): Promise<GraphNode[]> {
    try {
      const graph = await readGraphFile(repoRoot);
      const q = typeof query === 'string' ? query.toLowerCase() : '';
      if (!q) return [];

      const results = graph.nodes.filter((node) => {
        const title = typeof node.title === 'string' ? node.title.toLowerCase() : '';
        return title.includes(q);
      });

      return results.slice(0, limit);
    } catch (err) {
      console.error('Graph query failed:', err);
      return [];
    }
  }

  /**
   * Find code related to a query. Stubbed to an empty list for now; full FTS
   * search (delegating to graph.mjs rollupCodeRefs over the KB) lands in a
   * later phase. Returning empty is the safe non-crashing default.
   */
  async findRelatedCode(repoRoot: URL, query: string, limit = 10): Promise<CodeRef[]> {
    try {
      // TODO: Implement full FTS search in later phases (delegating to
      // graph.mjs rollupCodeRefs over the KB). Returning empty is the safe
      // non-crashing default; `limit` is honored now so the eventual
      // implementation inherits the cap.
      const results: CodeRef[] = [];
      return results.slice(0, limit);
    } catch (err) {
      console.error('Related code search failed:', err);
      return [];
    }
  }

  /**
   * Regenerate graph. Currently just refreshes the doc fingerprint so callers
   * can detect subsequent drift; full regeneration lands in a later phase.
   *
   * Unlike reads, a failed fingerprint write is re-thrown after logging so
   * callers can surface the failure rather than silently corrupting state.
   */
  async regenerateGraph(repoRoot: URL): Promise<void> {
    try {
      await writeDocFingerprint(repoRoot, Date.now().toString());
    } catch (err) {
      console.error('Graph regeneration failed:', err);
      throw err;
    }
  }
}

// Singleton instance.
export const graphService = new GraphService();
