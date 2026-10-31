// Filter state and the visibility mask it produces. Filters hide, they never delete: the mask is
// recomputed from the model on every change (O(n + m) typed-array passes).
import type { GraphModel, LayoutResult } from "./model.ts";
import { edgeWeight } from "./weights.ts";

export type Preset = "all" | "code" | "docs";

const CODE = new Set(["file", "symbol", "module", "function", "classType", "config", "service", "table", "endpoint", "pipeline", "schemaNode", "resource", "domain", "flow", "step", "other"]);
const DOCS = new Set(["docPage", "memoryDoc", "memoryChunk", "noteDecision", "noteTask", "noteQuestion", "noteFact", "noteConcept", "notePlaybook", "noteHypothesis", "noteEvent", "noteSource", "article", "entity", "topic", "claim", "skill", "agent"]);

export interface FilterState {
  preset: Preset;
  /** Node kind names switched off by the user (on top of the preset). */
  hiddenKinds: ReadonlySet<string>;
  /** Only this community, or null for all. */
  community: number | null;
  /** Edges lighter than this are hidden (0..1). */
  minWeight: number;
}

export const DEFAULT_MIN_WEIGHT = 0.3; // the Mac's default floor: associative guesses stay behind the slider

export const initialFilters = (): FilterState => ({ preset: "all", hiddenKinds: new Set(), community: null, minWeight: DEFAULT_MIN_WEIGHT });

export function kindAllowed(kind: string, f: FilterState): boolean {
  if (f.hiddenKinds.has(kind)) return false;
  if (f.preset === "code") return CODE.has(kind);
  if (f.preset === "docs") return DOCS.has(kind);
  return true;
}

/** 1 for nodes the filters allow. */
export function nodeMask(model: GraphModel, layout: LayoutResult, f: FilterState): Uint8Array {
  const allowedKind = model.nodeKinds.map((k) => kindAllowed(k, f));
  const mask = new Uint8Array(model.n);
  for (let i = 0; i < model.n; i++) {
    if (!allowedKind[model.kindOf[i]]) continue;
    if (f.community !== null && layout.community[i] !== f.community) continue;
    mask[i] = 1;
  }
  return mask;
}

/** Weight per edge, from kind and confidence. */
export function edgeWeights(model: GraphModel): Float32Array {
  const table = model.edgeKinds.map((k) => edgeWeight(k, 0));
  const w = new Float32Array(model.m);
  for (let e = 0; e < model.m; e++) {
    const c = model.conf[e];
    w[e] = table[model.edgeKind[e]] * (c === 0 ? 1 : c === 1 ? 0.75 : 0.45);
  }
  return w;
}

export interface CommunityInfo {
  id: number;
  size: number;
  /** Most important member (a human label for the community). */
  label: number;
}

/** Communities by size, largest first, labelled by their top-ranked member. */
export function communitySummary(model: GraphModel, layout: LayoutResult, limit = 200): CommunityInfo[] {
  const size = new Map<number, number>();
  const top = new Map<number, number>();
  for (let i = 0; i < model.n; i++) {
    const c = layout.community[i];
    size.set(c, (size.get(c) ?? 0) + 1);
    const t = top.get(c);
    if (t === undefined || layout.rank[i] < layout.rank[t]) top.set(c, i);
  }
  return [...size.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id, s]) => ({ id, size: s, label: top.get(id) ?? 0 }));
}

/** Neighbour lists in CSR form for selection highlight and the details panel (undirected). */
export interface Adjacency {
  start: Uint32Array;
  nbr: Uint32Array;
  edge: Uint32Array;
}

export function buildAdjacency(model: GraphModel): Adjacency {
  const n = model.n;
  const start = new Uint32Array(n + 1);
  for (let e = 0; e < model.m; e++) {
    start[model.from[e] + 1]++;
    start[model.to[e] + 1]++;
  }
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const fill = start.slice(0, n);
  const nbr = new Uint32Array(start[n]);
  const edge = new Uint32Array(start[n]);
  for (let e = 0; e < model.m; e++) {
    const a = model.from[e], b = model.to[e];
    nbr[fill[a]] = b; edge[fill[a]++] = e;
    nbr[fill[b]] = a; edge[fill[b]++] = e;
  }
  return { start, nbr, edge };
}
