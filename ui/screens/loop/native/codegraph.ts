// Native code-graph stage. It rescans the run's repository, snapshots the graph under system/loop/refactor/graph/, and
// verifies the batch did not make the structure worse. It reads both graph shapes: graph-kit's canonical document
// (`nodes` + `edges`, which the desktop writes) and the Mac's older `files` + `calls` report.
//
// A refactor may rightly shrink the graph (a dead file deleted, duplicates merged), so fewer nodes or edges is reported,
// not failed. What fails: a new import cycle, a new file over 500 lines (old shape only), or a graph that came back empty.
import type { FsApi } from "../../explorer/fs";

export type CodeGraphFs = Pick<FsApi, "read" | "write" | "create">;
export interface GraphShape { files: number; nodes: number; edges: number; cycles: number; over500: number }
export interface CodeGraphResult { passed: boolean; output: string }

interface GraphDoc {
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

async function readShape(fs: CodeGraphFs, path: string): Promise<GraphShape | null> {
  try {
    const r = await fs.read(path, 20_000_000);
    if (r.status !== "ok" || !r.text) return null;
    return graphShape(JSON.parse(r.text) as GraphDoc);
  } catch { return null; }
}

/** Tarjan SCC count: an SCC with more than one file, or a self-edge, is one import cycle. */
export function cycleCount(calls: readonly { from?: string; to?: string }[]): number {
  const adj = new Map<string, string[]>();
  for (const c of calls) {
    if (!c.from || !c.to) continue;
    if (!adj.has(c.from)) adj.set(c.from, []);
    adj.get(c.from)!.push(c.to);
    if (!adj.has(c.to)) adj.set(c.to, []);
  }
  let index = 0; let cycles = 0;
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
      if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) cycles += 1;
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) strong(v);
  return cycles;
}

async function ensureDir(fs: CodeGraphFs, path: string): Promise<void> {
  let at = "";
  for (const seg of path.split("/").slice(0, -1)) { at = at ? `${at}/${seg}` : seg; try { await fs.create(at, "dir"); } catch (e) { if ((e as { code?: string })?.code !== "exists") throw e; } }
}

export async function runCodeGraph(fs: CodeGraphFs, op: "snapshot" | "verify", graphPath: string, beforePath: string, rescan?: () => Promise<void>): Promise<CodeGraphResult> {
  if (rescan) {
    try { await rescan(); } catch (e) { return { passed: false, output: `graph rescan failed: ${e instanceof Error ? e.message : String(e)}` }; }
  }
  const current = await readShape(fs, graphPath);
  if (!current) return { passed: false, output: `no readable graph at ${graphPath}; run the Graph page scan first` };
  if (op === "snapshot") {
    const raw = await fs.read(graphPath, 20_000_000);
    if (raw.status !== "ok" || !raw.text) return { passed: false, output: "the graph file could not be read" };
    await ensureDir(fs, beforePath);
    await fs.write(beforePath, raw.text, { expected_hash: null });
    return { passed: true, output: `snapshot · ${current.files} file(s), ${current.nodes} node(s), ${current.edges} edge(s), ${current.cycles} cycle(s), ${current.over500} over 500 lines → ${beforePath}` };
  }
  const before = await readShape(fs, beforePath);
  if (!before) return { passed: false, output: `no snapshot at ${beforePath}; run the snapshot graph stage first` };
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
