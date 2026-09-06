// Joins the code and doc tracks into one graph, adding doc→code cross-links.
//
// Port of Swift `GraphKit.GraphMerger`. This is ENGINE logic: it must live in
// the engine, not in a host adapter, or the host silently loses it the day the
// engine is unplugged — and the other implementation has nothing to stay in
// step with.
//
// Three cross-link mechanisms, in descending precedence:
//
//   1. `[[wikilinks]]` from a chunk to a code symbol      references / EXTRACTED
//   2. declared `related-modules:` frontmatter affinity   documents  / EXTRACTED
//   3. inline backtick mentions resolved against the      references / INFERRED
//      code inventory (see docCodeLinker)
//
// A chunk's heading-derived title is deliberately NOT matched: generic headings
// ("Config", "Setup", "main") collide with symbol names and would manufacture
// false edges.

import type { CGData, CGEdge, CGNode } from "../models.js";
import { docCodeLinks, type MergeChunk } from "../text/docCodeLinker.js";

export type { MergeChunk };

/** Files linked per declared module — fan-OUT cap. A directory declaration
 *  must not become an unbounded hub. */
const MAX_FILES_PER_MODULE = 8;

/**
 * Chunks linked per file — fan-IN cap.
 *
 * Fan-out alone is not enough: when every chunk in a docs-heavy repo declares
 * the same module (a template, or a shared `related-modules: extension/kb`
 * convention), the 8 files under it absorb one edge from EVERY chunk. Measured
 * at 1589 chunks, that gave those files a 32x repulsion mass over every other
 * node and pinned their PageRank at 1.0 — the hub-domination failure the layout
 * work removed, reintroduced through a new edge source. The first
 * MAX_CHUNKS_PER_FILE chunks in input order (document order, so deterministic)
 * keep the link: the signal stays, the asymmetry is bounded.
 */
const MAX_CHUNKS_PER_FILE = 32;

/**
 * Normalise a declared module path to the repo-relative prefix the code
 * inventory uses.
 *
 * Authors write modules in several natural forms — `kb`, `kb/`, `./kb`, `kb/*`,
 * `kb/**` — and before normalisation everything but the first two silently
 * produced zero edges, which is the exact silent-zero failure this feature
 * exists to close. Matching is case-insensitive, mirroring the inventory.
 *
 * Returns null for forms that cannot name a repo path (empty, `.`, anything
 * containing `..` — resolving parent references against an unknown base would
 * be a guess).
 */
export function normalizeModulePrefix(module: string): string | null {
  let prefix = module.toLowerCase().trim();
  if (prefix.startsWith("./")) prefix = prefix.slice(2);
  for (const suffix of ["/**", "/*"]) {
    if (prefix.endsWith(suffix)) prefix = prefix.slice(0, -suffix.length);
  }
  prefix = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!prefix || prefix === ".") return null;
  if (prefix.split("/").includes("..")) return null;
  return prefix;
}

/**
 * Merge the code and doc graphs, adding doc→code cross-links.
 *
 * Node ids are namespaced (code paths/symbols vs `doc:`/chunk hashes) so the
 * union cannot collide, and a chunk's graph-node id equals its `MemoryChunk.id`,
 * so a cross-link's `fromId` resolves to a real node.
 */
export function mergeCodeAndDoc(code: CGData, doc: CGData, chunks: MergeChunk[]): CGData {
  const nodes: CGNode[] = [];
  const seen = new Set<string>();
  for (const node of [...code.nodes, ...doc.nodes]) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
  }
  const edges: CGEdge[] = [...code.edges, ...doc.edges];

  // Carried through explicitly: every earlier transform in this pipeline
  // dropped layers/tour by rebuilding the graph from nodes and edges alone.
  const carried = {
    layers: [...(code.layers ?? []), ...(doc.layers ?? [])],
    tour: [...(code.tour ?? []), ...(doc.tour ?? [])],
  };

  const codeIdsByTitle = new Map<string, string[]>();
  for (const node of code.nodes) {
    const key = node.title.toLowerCase();
    const bucket = codeIdsByTitle.get(key);
    if (bucket) bucket.push(node.id);
    else codeIdsByTitle.set(key, [node.id]);
  }
  if (codeIdsByTitle.size === 0) {
    return { nodes, edges, ...carried };
  }

  const crossSeen = new Set<string>();
  const linkOnce = (from: string, to: string, kind: CGEdge["kind"],
                    confidence: CGEdge["confidence"]): boolean => {
    const key = `${from}->${to}`;
    if (crossSeen.has(key)) return false;
    crossSeen.add(key);
    edges.push({ fromId: from, toId: to, kind, confidence });
    return true;
  };

  // (1) Wikilinks — author-asserted, so EXTRACTED.
  for (const chunk of chunks) {
    for (const name of chunk.wikiLinks ?? []) {
      for (const codeId of codeIdsByTitle.get(name.toLowerCase()) ?? []) {
        linkOnce(chunk.id, codeId, "references", "EXTRACTED");
      }
    }
  }

  // Mention inventory: node titles plus any explicit relative-path metadata,
  // lowercased. No separate basename key is needed — the code graph builder
  // always titles a `file` node with the path's basename, so a basename mention
  // already hits `codeIdsByTitle`.
  const inventory = new Map(codeIdsByTitle);
  for (const node of code.nodes) {
    const path = node.metadata?.["source_file"]?.toLowerCase();
    if (path && !inventory.has(path)) inventory.set(path, [node.id]);
  }

  // (2) Declared module affinity. This is the one author-asserted,
  // high-precision doc→code signal in the system; in the Swift implementation
  // it produced ZERO edges for a long time while the noisy backtick heuristic
  // produced thousands, which is a measured part of why a real repo's doc
  // chunks arrived fully disconnected from its code.
  const fileIdsByPath: Array<{ path: string; id: string }> = [];
  for (const node of code.nodes) {
    if (node.kind !== "file") continue;
    const path = node.metadata?.["source_file"]?.toLowerCase();
    if (path) fileIdsByPath.push({ path, id: node.id });
  }
  fileIdsByPath.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const fanIn = new Map<string, number>();
  for (const chunk of chunks) {
    for (const module of chunk.relatedModules ?? []) {
      const prefix = normalizeModulePrefix(module);
      if (prefix === null) continue;
      let linked = 0;
      for (const { path, id } of fileIdsByPath) {
        if (linked >= MAX_FILES_PER_MODULE) break;
        if (!(path === prefix || path.startsWith(prefix + "/"))) continue;
        if ((fanIn.get(id) ?? 0) >= MAX_CHUNKS_PER_FILE) continue;
        // `documents` — the chunk documents that module — at EXTRACTED: the
        // author stated it, nothing was inferred.
        if (!linkOnce(chunk.id, id, "documents", "EXTRACTED")) continue;
        fanIn.set(id, (fanIn.get(id) ?? 0) + 1);
        linked += 1;
      }
    }
  }

  // (3) Backtick mentions. The linker scores a mention 0.9 when path-shaped and
  // 0.7 when only symbol-shaped; both are heuristics over surface text, so both
  // map to INFERRED. Preserving the numeric score would need a confidence tier
  // the canonical schema does not have.
  for (const link of docCodeLinks(chunks, inventory)) {
    linkOnce(link.chunkId, link.codeNodeId, "references", "INFERRED");
  }

  return { nodes, edges, ...carried };
}
