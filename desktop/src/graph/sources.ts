import type Graph from "graphology";
import { invoke } from "@tauri-apps/api/core";
import { buildSyntheticGraph } from "./synthetic";
import { buildGraphKitGraph, REAL_GRAPH_PATH } from "./realGraph";
import { seedPositions } from "./layout";

export type SourceId = "synthetic-10k" | "synthetic-50k" | "real";

export const SOURCE_LABELS: Record<SourceId, string> = {
  "synthetic-10k": "Synthetic 10k nodes / 30k edges",
  "synthetic-50k": "Synthetic 50k nodes / 150k edges",
  real: "Real: affiliate project graph.json",
};

/** ForceAtlas2 iterations per scenario. The layout metric is wall time for exactly this many. */
export const LAYOUT_ITERATIONS: Record<SourceId, number> = {
  "synthetic-10k": 100,
  "synthetic-50k": 30,
  real: 300,
};

/** Hard safety timeout for one layout run; on expiry the worker stops and `timed_out` is reported. */
export const LAYOUT_TIMEOUT_MS = 120_000;

/** BENCH suffix per source, used in metric names (graph_fps_10k, graph_layout_ms_real, ...). */
export const SOURCE_SUFFIX: Record<SourceId, string> = {
  "synthetic-10k": "10k",
  "synthetic-50k": "50k",
  real: "real",
};

/** Builds the graph with seeded starting positions (layout not yet run). */
export async function buildSource(id: SourceId): Promise<Graph> {
  if (id === "real") {
    // LLMIDE_POC_GRAPH overrides the default path (resolved by the Rust side).
    const override = await invoke<string | null>("graph_path_override");
    const json = await invoke<string>("read_graph_file", { path: override ?? REAL_GRAPH_PATH });
    const graph = buildGraphKitGraph(json);
    seedPositions(graph, 7);
    return graph;
  }
  const nodes = id === "synthetic-10k" ? 10_000 : 50_000;
  const graph = buildSyntheticGraph(nodes, 3, nodes);
  seedPositions(graph, nodes + 1);
  return graph;
}
