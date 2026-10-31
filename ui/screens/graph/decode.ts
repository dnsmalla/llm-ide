// Strict decoder for graph.json. The file is untrusted (a repository can ship one), so:
//  - the shape is checked, anything unexpected is skipped and counted, never trusted;
//  - node and edge counts and string sizes are capped, with a notice when a cap bites;
//  - unknown node kinds map to "other"; unknown edge kinds map to "relatedTo" (weight 0.24: kept, drawn,
//    filtered by the slider, never pruned);
//  - control characters are stripped from every string; paths must be project-relative without "..".
// Two producers are accepted: graph-kit's on-disk graph.json 1.1 (`files[]` + `calls[]`, what the Mac scanner
// writes under system/graph/) and the canonical GraphDocument (`schemaVersion` + `nodes[]` + `edges[]`).
import { DEFAULT_CAPS, type Caps, type GraphModel } from "./model.ts";
import { EDGE_BASE_WEIGHT, parseConfidence } from "./weights.ts";

export class GraphDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphDecodeError";
  }
}

export const NODE_KINDS = [
  "file", "symbol", "module", "function", "classType", "config", "service", "table", "endpoint", "pipeline",
  "schemaNode", "resource", "domain", "flow", "step", "docPage", "memoryDoc", "memoryChunk", "noteDecision",
  "noteTask", "noteQuestion", "noteFact", "noteConcept", "notePlaybook", "noteHypothesis", "noteEvent",
  "noteSource", "article", "entity", "topic", "claim", "skill", "agent", "other",
] as const;
const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Text for display: control and bidi-override characters removed, length capped. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.length > max * 2 ? v.slice(0, max * 2) : v;
  const t = s.replace(CONTROL, "");
  return t.length > max ? t.slice(0, max) : t;
}

/** A project-relative path with "/" separators, or null (absolute, "..", drive letters, control characters). */
export function relativePath(v: unknown, max: number): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > max) return null;
  if (/[\u0000-\u001f\u007f:]/.test(v)) return null;
  const p = v.replaceAll("\\", "/");
  if (p.startsWith("/")) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

class Builder {
  ids: string[] = [];
  titles: string[] = [];
  kinds: number[] = [];
  paths: (string | null)[] = [];
  meta: (Record<string, string> | null)[] = [];
  index = new Map<string, number>();
  nodeKinds: string[] = [];
  private kindIdx = new Map<string, number>();
  edgeKinds: string[] = [];
  private edgeKindIdx = new Map<string, number>();
  from: number[] = [];
  to: number[] = [];
  ek: number[] = [];
  conf: number[] = [];
  notices: string[] = [];
  skippedNodes = 0;
  duplicateIds = 0;
  skippedEdges = 0;
  unknownEdgeKinds = 0;
  unknownNodeKinds = 0;
  nodesCapped = false;
  edgesCapped = false;
  readonly caps: Caps;
  constructor(caps: Caps) {
    this.caps = caps;
  }

  kind(k: string): number {
    let i = this.kindIdx.get(k);
    if (i === undefined) {
      i = this.nodeKinds.length;
      this.nodeKinds.push(k);
      this.kindIdx.set(k, i);
    }
    return i;
  }
  edgeKind(k: string): number {
    let i = this.edgeKindIdx.get(k);
    if (i === undefined) {
      i = this.edgeKinds.length;
      this.edgeKinds.push(k);
      this.edgeKindIdx.set(k, i);
    }
    return i;
  }

  /** Index of the node, adding it when new; -1 when the node cap is reached. */
  node(id: string, title: string, kind: string, path: string | null, meta: Record<string, string> | null): number {
    const hit = this.index.get(id);
    if (hit !== undefined) {
      this.duplicateIds++;
      return hit;
    }
    if (this.ids.length >= this.caps.maxNodes) {
      this.nodesCapped = true;
      return -1;
    }
    const i = this.ids.length;
    this.index.set(id, i);
    this.ids.push(id);
    this.titles.push(title);
    this.kinds.push(this.kind(kind));
    this.paths.push(path);
    this.meta.push(meta);
    return i;
  }

  edge(a: number, b: number, kind: string, conf: number): void {
    if (a < 0 || b < 0 || a === b) {
      if (a !== b) this.skippedEdges++;
      return;
    }
    if (this.from.length >= this.caps.maxEdges) {
      this.edgesCapped = true;
      return;
    }
    let k = kind;
    if (!(k in EDGE_BASE_WEIGHT)) {
      this.unknownEdgeKinds++;
      k = "relatedTo";
    }
    this.from.push(a);
    this.to.push(b);
    this.ek.push(this.edgeKind(k));
    this.conf.push(conf);
  }

  finish(format: GraphModel["format"]): GraphModel {
    const c = this.caps;
    if (this.nodesCapped) this.notices.push(`Only the first ${c.maxNodes.toLocaleString("en-US")} nodes were loaded (cap); the rest were skipped.`);
    if (this.edgesCapped) this.notices.push(`Only the first ${c.maxEdges.toLocaleString("en-US")} edges were loaded (cap); the rest were skipped.`);
    if (this.skippedNodes) this.notices.push(`${this.skippedNodes.toLocaleString("en-US")} malformed node entries were skipped.`);
    if (this.skippedEdges) this.notices.push(`${this.skippedEdges.toLocaleString("en-US")} edges pointed at missing nodes and were skipped.`);
    if (this.duplicateIds) this.notices.push(`${this.duplicateIds.toLocaleString("en-US")} repeated node ids were merged (first one kept).`);
    if (this.unknownNodeKinds) this.notices.push(`${this.unknownNodeKinds.toLocaleString("en-US")} nodes of an unknown kind are shown as "other".`);
    if (this.unknownEdgeKinds) this.notices.push(`${this.unknownEdgeKinds.toLocaleString("en-US")} edges of an unknown kind are treated as "relatedTo".`);
    return {
      format,
      n: this.ids.length,
      m: this.from.length,
      ids: this.ids,
      titles: this.titles,
      kindOf: Uint8Array.from(this.kinds),
      nodeKinds: this.nodeKinds,
      paths: this.paths,
      meta: this.meta,
      from: Uint32Array.from(this.from),
      to: Uint32Array.from(this.to),
      edgeKind: Uint8Array.from(this.ek),
      edgeKinds: this.edgeKinds,
      conf: Uint8Array.from(this.conf),
      notices: this.notices,
    };
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cleanMeta(v: unknown, caps: Caps): Record<string, string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = Object.create(null);
  let count = 0;
  for (const key of Object.keys(v)) {
    if (count >= caps.maxMetaKeys) break;
    const val = v[key];
    if (typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") continue;
    const k = cleanText(key, 60);
    if (!k || k === "__proto__") continue;
    out[k] = cleanText(String(val), caps.maxMetaValue);
    count++;
  }
  return count ? out : null;
}

function decodeKit(root: Record<string, unknown>, caps: Caps): GraphModel {
  const b = new Builder(caps);
  const files = root.files;
  const calls = root.calls;
  if (!Array.isArray(files)) throw new GraphDecodeError("graph.json has no files[] list");
  for (const f of files) {
    if (!isObj(f)) {
      b.skippedNodes++;
      continue;
    }
    const path = relativePath(f.path, caps.maxPath);
    if (path === null) {
      b.skippedNodes++;
      continue;
    }
    const name = cleanText(f.name, caps.maxLabel) || path.slice(path.lastIndexOf("/") + 1);
    const meta: Record<string, string> = Object.create(null);
    const lang = cleanText(f.language, 40);
    if (lang) meta.language = lang;
    const role = cleanText(f.role, 40);
    if (role) meta.role = role;
    if (typeof f.loc === "number" && Number.isFinite(f.loc)) meta.loc = String(Math.trunc(f.loc));
    b.node(path, name, "file", path, Object.keys(meta).length ? meta : null);
  }
  // Import edges: usedBy and imports both name files; only exact known paths become edges (a module
  // specifier like "react" is not a node). One edge per (importer, imported) pair.
  const seen = new Set<string>();
  const imp = (from: string, to: string) => {
    const a = b.index.get(from);
    const c = b.index.get(to);
    if (a === undefined || c === undefined || a === c) return;
    const key = `${a}>${c}`;
    if (seen.has(key)) return;
    seen.add(key);
    b.edge(a, c, "imports", 0);
  };
  for (const f of files) {
    if (!isObj(f)) continue;
    const path = relativePath(f.path, caps.maxPath);
    if (path === null) continue;
    if (Array.isArray(f.imports)) for (const t of f.imports) { const p = relativePath(t, caps.maxPath); if (p !== null) imp(path, p); }
    if (Array.isArray(f.usedBy)) for (const t of f.usedBy) { const p = relativePath(t, caps.maxPath); if (p !== null) imp(p, path); }
  }
  if (Array.isArray(calls)) {
    const seenCall = new Set<string>();
    for (const c of calls) {
      if (!isObj(c)) { b.skippedEdges++; continue; }
      const from = relativePath(c.from, caps.maxPath);
      const to = relativePath(c.to, caps.maxPath);
      if (from === null || to === null) { b.skippedEdges++; continue; }
      const a = b.index.get(from) ?? b.node(from, from.slice(from.lastIndexOf("/") + 1), "file", from, null);
      const d = b.index.get(to) ?? b.node(to, to.slice(to.lastIndexOf("/") + 1), "file", to, null);
      const key = `${a}>${d}`;
      if (seenCall.has(key)) continue; // parallel call records between two files: one weighted edge
      seenCall.add(key);
      b.edge(a, d, "calls", 1);
    }
  }
  return b.finish("graph-kit-1.1");
}

function decodeDocument(root: Record<string, unknown>, caps: Caps): GraphModel {
  const b = new Builder(caps);
  const nodes = root.nodes;
  const edges = root.edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new GraphDecodeError("graph document needs nodes[] and edges[]");
  for (const nd of nodes) {
    if (!isObj(nd) || typeof nd.id !== "string" || nd.id.length === 0 || nd.id.length > caps.maxPath * 2) {
      b.skippedNodes++;
      continue;
    }
    const id = cleanText(nd.id, caps.maxPath * 2);
    let kind = typeof nd.kind === "string" ? nd.kind : "other";
    if (!NODE_KIND_SET.has(kind)) { kind = "other"; b.unknownNodeKinds++; }
    const meta = cleanMeta(nd.metadata, caps);
    const path = relativePath(meta?.path ?? meta?.source_file ?? meta?.filePath, caps.maxPath);
    b.node(id, cleanText(nd.title, caps.maxLabel) || id.slice(0, caps.maxLabel), kind, path, meta);
  }
  for (const e of edges) {
    if (!isObj(e) || typeof e.fromId !== "string" || typeof e.toId !== "string") { b.skippedEdges++; continue; }
    const a = b.index.get(cleanText(e.fromId, caps.maxPath * 2));
    const d = b.index.get(cleanText(e.toId, caps.maxPath * 2));
    if (a === undefined || d === undefined) { b.skippedEdges++; continue; }
    b.edge(a, d, typeof e.kind === "string" ? e.kind : "relatedTo", parseConfidence(e.confidence));
  }
  return b.finish("graph-document-1");
}

/** Decode graph.json text. Throws `GraphDecodeError` (a message safe to show) when it is not a graph at all. */
export function decodeGraph(text: string, caps: Caps = DEFAULT_CAPS): GraphModel {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new GraphDecodeError("graph.json is not valid JSON");
  }
  if (!isObj(root)) throw new GraphDecodeError("graph.json must be a JSON object");
  if (Array.isArray(root.files)) return decodeKit(root, caps);
  if (Array.isArray(root.nodes)) {
    if (typeof root.schemaVersion === "number" && root.schemaVersion > 1) {
      throw new GraphDecodeError(`graph document schemaVersion ${root.schemaVersion} is newer than this app understands (1)`);
    }
    return decodeDocument(root, caps);
  }
  throw new GraphDecodeError("graph.json has neither files[] (graph-kit 1.1) nor nodes[] (graph document)");
}
