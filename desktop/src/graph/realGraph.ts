import Graph from "graphology";

/** The user's project graph (graph-kit graph.json 1.1). Read via Rust `read_graph_file`. */
export const REAL_GRAPH_PATH =
  "/Users/dinsmallade/Desktop/LLM/code/affiliate/system/graph/graph.json";

interface GraphKitFile {
  path: string;
  name?: string;
}
interface GraphKitCall {
  from: string;
  to: string;
  symbol?: string;
}

/**
 * Maps graph-kit graph.json. Only `calls[]` is drawn: one edge per call record.
 * The file-level import edges behind `summary.totalEdges` are NOT drawn (the
 * summary counts those, `calls[]` is what this view renders).
 *
 * Maps graph-kit graph.json to a graphology multigraph: one node per file
 * (keyed by path), one edge per call record (`from` file -> `to` file). Parallel
 * calls between the same two files stay as separate edges; nothing is pruned.
 */
export function buildGraphKitGraph(json: string): Graph {
  const data = JSON.parse(json) as { files?: unknown; calls?: unknown };
  if (!Array.isArray(data.files) || !Array.isArray(data.calls)) {
    throw new Error("graph.json: expected top-level files[] and calls[]");
  }
  const files = data.files as GraphKitFile[];
  const calls = data.calls as GraphKitCall[];
  const graph = new Graph({ type: "directed", multi: true });
  const ensure = (path: string, label?: string) => {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("graph.json: call endpoint is not a path");
    }
    if (!graph.hasNode(path)) {
      graph.addNode(path, {
        size: 2,
        color: "#4f7cff",
        label: label ?? path.split("/").pop() ?? path,
      });
    }
  };
  for (const f of files) ensure(f.path, f.name);
  for (const c of calls) {
    ensure(c.from);
    ensure(c.to);
    graph.addEdge(c.from, c.to);
  }
  return graph;
}
