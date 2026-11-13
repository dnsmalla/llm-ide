// Graph generation is graph-kit code, never a model: the graph is validated (validateGraphDoc) before it is used.
// Native code-graph stage. It rescans the run's repository, snapshots the graph under system/loop/refactor/graph/, and
// verifies the batch did not make the structure worse. It reads both graph shapes: graph-kit's canonical document
// (`nodes` + `edges`, which the desktop writes) and the Mac's older `files` + `calls` report.
//
// A refactor may rightly shrink the graph (a dead file deleted, duplicates merged), so fewer nodes or edges is reported,
// not failed. What fails: a new import cycle, a new file over 500 lines (old shape only), or a graph that came back empty.
import type { FsApi } from "../../explorer/fs";

export type CodeGraphFs = Pick<FsApi, "read" | "write" | "create">;
export interface GraphShape { files: number; nodes: number; edges: number; cycles: number; over500: number }
/** `graph` is the validated snapshot document, set on a successful snapshot (the digest is built from it). */
export interface CodeGraphResult { passed: boolean; output: string; graph?: GraphDoc }
/** The most a loop reads of a code graph: the host's read cap (fs_ops.rs READ_HARD_MAX). */
export const GRAPH_READ_MAX = 32 * 1024 * 1024;
/** graph-kit stops scanning at this many files; a snapshot that reaches it says so. */
export const GRAPH_FILE_LIMIT = 20_000;

export interface GraphDoc {
  nodes?: Array<{ id?: string; kind?: string }>; edges?: Array<{ fromId?: string; toId?: string; kind?: string }>;
  calls?: Array<{ from?: string; to?: string }>; files?: Array<{ path?: string; loc?: number; functions?: unknown[] }>;
}

/** The shape of a parsed graph document (either format). */
export function graphShape(g: GraphDoc): GraphShape {
  const fnCount = (g.files ?? []).reduce((n, f) => n + (Array.isArray(f.functions) ? f.functions.length : 0), 0);
  // graph-kit: file→file `imports` edges are the import graph; anything else (a module node, a symbol) is not a file cycle.
  const fileImports = (g.edges ?? [])
    .filter((e) => e.kind === "imports" && e.fromId?.startsWith("file:") && e.toId?.startsWith("file:"))
    .map((e) => ({ from: e.fromId, to: e.toId }));
  return {
    nodes: g.nodes?.length ?? fnCount,
    edges: (g.edges?.length ?? 0) + (g.calls?.length ?? 0),
    files: g.files ? g.files.length : (g.nodes ?? []).filter((n) => n.kind === "file").length,
    cycles: cycleCount(g.calls ?? []) + cycleCount(fileImports),
    over500: (g.files ?? []).filter((f) => (f.loc ?? 0) > 500).length,
  };
}

/** The first problem with a parsed graph document, or null when it can be used. */
export function validateGraphDoc(doc: unknown): string | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "the graph file is not a graph document";
  const d = doc as { schemaVersion?: unknown; nodes?: unknown; edges?: unknown; files?: unknown; calls?: unknown };
  if (!Array.isArray(d.nodes)) {
    if (!Array.isArray(d.files) && !Array.isArray(d.calls)) return "the graph file is not a graph document";
    if (d.files !== undefined && !Array.isArray(d.files)) return "the graph's files is not a list";
    if (d.calls !== undefined && !Array.isArray(d.calls)) return "the graph's calls is not a list";
    return null;
  }
  if (typeof d.schemaVersion !== "number" || !Number.isFinite(d.schemaVersion)) return "the graph has no numeric schemaVersion";
  const nodes = d.nodes as Array<{ id?: unknown; kind?: unknown } | null>;
  const ids = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!n || typeof n.id !== "string" || n.id === "") return `node ${i + 1} has no id`;
    if (typeof n.kind !== "string") return `node ${i + 1} (${n.id}) has no kind`;
    ids.set(n.id, (ids.get(n.id) ?? 0) + 1);
  }
  for (const [id, count] of ids) if (count > 1) return `${count} nodes share the id ${id}`;
  if (!Array.isArray(d.edges)) return "the graph has no edges list";
  const edges = d.edges as Array<{ fromId?: unknown; toId?: unknown; kind?: unknown } | null>;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e || typeof e.fromId !== "string" || e.fromId === "") return `edge ${i + 1} has no fromId`;
    if (typeof e.toId !== "string" || e.toId === "") return `edge ${i + 1} has no toId`;
    if (typeof e.kind !== "string" || e.kind === "") return `edge ${i + 1} has no kind`;
  }
  const dangling = (edges as Array<{ fromId: string; toId: string }>).filter((e) => !ids.has(e.fromId) || !ids.has(e.toId));
  if (dangling.length) return `${dangling.length} edges point at a node that does not exist, for example ${dangling[0].fromId} -> ${dangling[0].toId}`;
  return null;
}

/** Parses and validates graph text; the parsed document is what the stage counts, so it is what it trusts. */
function checkGraph(text: string): { doc: GraphDoc } | { error: string } {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return { error: "the graph file is not valid JSON" }; }
  const error = validateGraphDoc(doc);
  return error ? { error } : { doc: doc as GraphDoc };
}

type GraphRead = { text: string } | { tooLarge: number | null } | null;

async function readText(fs: CodeGraphFs, path: string): Promise<GraphRead> {
  try {
    const r = await fs.read(path, GRAPH_READ_MAX);
    if (r.status === "too_large") return { tooLarge: typeof r.size === "number" ? r.size : null };
    return r.status === "ok" && r.text ? { text: r.text } : null;
  } catch { return null; }
}

const tooLarge = (size: number | null): string => `the code graph is ${size === null ? "" : `${Math.round(size / 1048576)} MB, `}over the 32 MB the app can read; set the loop's Input path to a folder to scan less`;

/** Tarjan SCC: each group of files in an import cycle (a group of more than one file, or a self-edge). */
export function cycleGroups(calls: readonly { from?: string; to?: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const c of calls) {
    if (!c.from || !c.to) continue;
    if (!adj.has(c.from)) adj.set(c.from, []);
    adj.get(c.from)!.push(c.to);
    if (!adj.has(c.to)) adj.set(c.to, []);
  }
  let index = 0; const cycles: string[][] = [];
  const idx = new Map<string, number>(); const low = new Map<string, number>(); const stack: string[] = []; const on = new Set<string>();
  const strong = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []; let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) cycles.push(comp);
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strong(v);
  return cycles;
}

export function cycleCount(calls: readonly { from?: string; to?: string }[]): number {
  return cycleGroups(calls).length;
}

/** Creates the folders above a file path (the last segment is the file). */
export async function ensureDir(fs: CodeGraphFs, path: string): Promise<void> {
  let at = "";
  for (const seg of path.split("/").slice(0, -1)) { at = at ? `${at}/${seg}` : seg; try { await fs.create(at, "dir"); } catch (e) { if ((e as { code?: string })?.code !== "exists") throw e; } }
}

export async function runCodeGraph(fs: CodeGraphFs, op: "snapshot" | "verify", graphPath: string, beforePath: string, rescan?: () => Promise<void>): Promise<CodeGraphResult> {
  if (rescan) {
    try { await rescan(); } catch (e) { return { passed: false, output: `graph rescan failed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const read = await readText(fs, graphPath);
  if (read === null) return { passed: false, output: `no readable graph at ${graphPath}; run the Graph page scan first` };
  if ("tooLarge" in read) return { passed: false, output: tooLarge(read.tooLarge) };
  const text = read.text;
  const cur = checkGraph(text);
  if ("error" in cur) return { passed: false, output: `graph invalid: ${cur.error}` };
  const current = graphShape(cur.doc);
  if (op === "snapshot") {
    if (Array.isArray(cur.doc.nodes) && cur.doc.nodes.length === 0) return { passed: false, output: "the scan found no code, so there is nothing to refactor" };
    // The validated text is what gets saved, so the baseline is exactly the graph that passed.
    await ensureDir(fs, beforePath);
    await fs.write(beforePath, text, { expected_hash: null, force: true });
    const limit = Array.isArray(cur.doc.nodes) && current.files >= GRAPH_FILE_LIMIT ? `\nwarning: the scan reached graph-kit's ${GRAPH_FILE_LIMIT}-file limit; files beyond it are not in the graph` : "";
    return { passed: true, output: `snapshot · ${current.files} file(s), ${current.nodes} node(s), ${current.edges} edge(s), ${current.cycles} cycle(s), ${current.over500} over 500 lines → ${beforePath}${limit}`, graph: cur.doc };
  }
  const baseRead = await readText(fs, beforePath);
  if (baseRead === null) return { passed: false, output: `no snapshot at ${beforePath}; run the snapshot graph stage first` };
  if ("tooLarge" in baseRead) return { passed: false, output: tooLarge(baseRead.tooLarge) };
  const base = checkGraph(baseRead.text);
  if ("error" in base) return { passed: false, output: `the baseline snapshot is invalid: ${base.error}; run the snapshot stage again` };
  const before = graphShape(base.doc);
  const worse: string[] = [];
  if (current.cycles > before.cycles) worse.push(`cycles ${before.cycles} → ${current.cycles}`);
  if (current.over500 > before.over500) worse.push(`files over 500 lines ${before.over500} → ${current.over500}`);
  if (before.nodes > 0 && current.nodes === 0) worse.push("the graph came back empty");
  const delta = (name: string, a: number, b: number) => `${b} ${name}${a === b ? "" : ` (${b > a ? "+" : ""}${b - a})`}`;
  const shape = [delta("file(s)", before.files, current.files), delta("node(s)", before.nodes, current.nodes), delta("edge(s)", before.edges, current.edges), delta("cycle(s)", before.cycles, current.cycles)].join(", ");
  return worse.length
    ? { passed: false, output: `graph regressed: ${worse.join(", ")} · ${shape}` }
    : { passed: true, output: `graph ok · ${shape}` };
}
