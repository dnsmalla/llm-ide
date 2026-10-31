// The decoded graph: struct-of-arrays so 50k nodes and 250k edges cost typed arrays plus one string array
// per text field, not one object each. Built by `decode.ts` (in a worker), read by layout, filters and renderer.

export type GraphFormat = "graph-kit-1.1" | "graph-document-1";

export interface GraphModel {
  format: GraphFormat;
  n: number;
  m: number;
  /** Stable node ids (unique; first occurrence wins). */
  ids: string[];
  /** Display labels: untrusted text, render as text only. */
  titles: string[];
  /** Index into `nodeKinds` per node. */
  kindOf: Uint8Array;
  nodeKinds: string[];
  /** Project-relative file path (validated) or null. */
  paths: (string | null)[];
  /** Small producer metadata (string to string, capped), or null. */
  meta: (Record<string, string> | null)[];
  from: Uint32Array;
  to: Uint32Array;
  /** Index into `edgeKinds` per edge. */
  edgeKind: Uint8Array;
  edgeKinds: string[];
  /** 0 EXTRACTED, 1 INFERRED, 2 AMBIGUOUS. */
  conf: Uint8Array;
  /** Human-readable notes about caps and repairs ("12 edges referenced unknown nodes, skipped"). */
  notices: string[];
}

export interface LayoutResult {
  n: number;
  /** x0,y0,x1,y1,... in layout units. */
  pos: Float32Array;
  /** Kernel radius per node (PageRank-scaled). */
  radius: Float32Array;
  community: Uint32Array;
  degree: Uint32Array;
  inDegree: Uint32Array;
  communityCount: number;
  /** 0 = most important node overall, then rising to 1. */
  rank: Float32Array;
  /** Same, within the node's community. */
  communityRank: Float32Array;
  /** Which engine produced the positions. */
  engine: "wasm" | "fallback";
  ms: number;
}

export interface Caps {
  maxNodes: number;
  maxEdges: number;
  maxLabel: number;
  maxPath: number;
  maxMetaKeys: number;
  maxMetaValue: number;
}

export const DEFAULT_CAPS: Caps = {
  maxNodes: 100_000,
  maxEdges: 600_000,
  maxLabel: 200,
  maxPath: 1024,
  maxMetaKeys: 12,
  maxMetaValue: 300,
};
