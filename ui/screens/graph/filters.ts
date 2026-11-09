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

/** The Mac's files-only view (`CodeGraphView.filesOnlyKinds`): what stays drawn while "Symbols" is off. */
export const FILES_ONLY_KINDS: ReadonlySet<string> = new Set([
  "file", "module", "docPage", "memoryDoc", "memoryChunk",
  "noteDecision", "noteTask", "noteQuestion", "noteFact", "noteConcept", "notePlaybook", "noteHypothesis", "noteEvent", "noteSource",
]);

/** Kinds the Symbols toggle switches: every kind in the graph that the files-only view does not keep. */
export function symbolKinds(model: GraphModel): string[] {
  return model.nodeKinds.filter((k) => !FILES_ONLY_KINDS.has(k));
}

/** Filters as the Mac opens a graph: symbols hidden (files-only), everything else on. A graph with no
 *  files-only kind at all (only symbols, or a plugin graph of entities/topics) opens with everything shown,
 *  so it never opens as an empty canvas. */
export function defaultFilters(model: GraphModel): FilterState {
  const hasFiles = model.nodeKinds.some((k) => FILES_ONLY_KINDS.has(k));
  return { ...initialFilters(), hiddenKinds: hasFiles ? new Set(symbolKinds(model)) : new Set() };
}

/** Whether "Symbols" is on: no symbol kind is hidden. Graphs without symbols (InfiniteBrain) have no toggle. */
export function symbolsShown(model: GraphModel, f: FilterState): boolean {
  return symbolKinds(model).every((k) => !f.hiddenKinds.has(k));
}

/** The hidden-kind set with every symbol kind shown or hidden, the other kinds untouched. */
export function setSymbolsShown(model: GraphModel, f: FilterState, on: boolean): Set<string> {
  const next = new Set(f.hiddenKinds);
  for (const k of symbolKinds(model)) {
    if (on) next.delete(k); else next.add(k);
  }
  return next;
}

/** Filters carried from the graph on screen (`prev`) to a refreshed one. A community the new layout does not have is
 *  cleared, or the canvas would be empty. A kind the new graph gained is hidden when "Symbols" was off on the old one,
 *  the same rule `defaultFilters` applies on open. */
export function carryFilters(prev: GraphModel | null, f: FilterState, next: GraphModel, layout: LayoutResult): FilterState {
  const communities = new Set(communitySummary(next, layout, Infinity).map((c) => c.id));
  const community = f.community !== null && !communities.has(f.community) ? null : f.community;
  let hiddenKinds = f.hiddenKinds;
  if (prev && !symbolsShown(prev, f)) {
    const known = new Set(prev.nodeKinds);
    const fresh = symbolKinds(next).filter((k) => !known.has(k));
    if (fresh.length > 0) hiddenKinds = new Set([...f.hiddenKinds, ...fresh]);
  }
  return { ...f, community, hiddenKinds };
}

/** InfiniteBrain (doc) kinds, the same set the Mac counts as "doc" in its code / doc split. */
export const isDocKind = (kind: string): boolean => kind.startsWith("note") || kind === "memoryDoc" || kind === "memoryChunk" || kind === "docPage";

/** Node counts split into code and doc, as the Mac's status line reports them. */
export function docSplit(model: GraphModel): { code: number; doc: number } {
  let doc = 0;
  const docKind = model.nodeKinds.map(isDocKind);
  for (let i = 0; i < model.n; i++) if (docKind[model.kindOf[i]]) doc++;
  return { code: model.n - doc, doc };
}

/** How many nodes a mask keeps. */
export const countOnes = (mask: Uint8Array): number => {
  let c = 0;
  for (let i = 0; i < mask.length; i++) c += mask[i];
  return c;
};

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
