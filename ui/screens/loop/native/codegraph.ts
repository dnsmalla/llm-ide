// Native code-graph stage. The Mac rescans and writes before/after graph snapshots plus GRAPH.md; this slice reads the
// graph the desktop already generated, snapshots it under system/loop/refactor/graph/, and verifies that the node/edge
// shape did not shrink. It does not rescan or compute the Mac's cycle/boundary report yet.
import type { FsApi } from "../../explorer/fs";

export type CodeGraphFs = Pick<FsApi, "read" | "write" | "create">;
export interface GraphShape { files: number; nodes: number; edges: number }
export interface CodeGraphResult { passed: boolean; output: string }

async function readShape(fs: CodeGraphFs, path: string): Promise<GraphShape | null> {
  try {
    const r = await fs.read(path, 20_000_000);
    if (r.status !== "ok" || !r.text) return null;
    const g = JSON.parse(r.text) as { nodes?: unknown[]; edges?: unknown[]; files?: Array<{ functions?: unknown[] }>; calls?: unknown[] };
    const fnCount = (g.files ?? []).reduce((n, f) => n + (Array.isArray(f.functions) ? f.functions.length : 0), 0);
    return { nodes: g.nodes?.length ?? fnCount, edges: (g.edges?.length ?? 0) + (g.calls?.length ?? 0), files: g.files?.length ?? 0 };
  } catch { return null; }
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
    return { passed: true, output: `snapshot · ${current.files} file(s), ${current.nodes} node(s), ${current.edges} edge(s) → ${beforePath}` };
  }
  const before = await readShape(fs, beforePath);
  if (!before) return { passed: false, output: `no snapshot at ${beforePath}; run the snapshot graph stage first` };
  const drops: string[] = [];
  if (current.nodes < before.nodes) drops.push(`nodes ${before.nodes} → ${current.nodes}`);
  if (current.edges < before.edges) drops.push(`edges ${before.edges} → ${current.edges}`);
  return drops.length
    ? { passed: false, output: `graph shrank: ${drops.join(", ")}` }
    : { passed: true, output: `graph stable · ${current.files} file(s), ${current.nodes} node(s), ${current.edges} edge(s)` };
}
