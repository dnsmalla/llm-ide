import Graph from "graphology";
import { mulberry32 } from "./prng";

/**
 * Preferential-attachment graph (Barabasi-Albert style). Each new node links
 * to `m` distinct existing nodes chosen proportionally to degree. Seeded, so a
 * given (nodeCount, m, seed) always yields the same graph. Edges are never
 * pruned: the result has every edge the generator produced.
 */
export function buildSyntheticGraph(nodeCount: number, m: number, seed: number): Graph {
  const rnd = mulberry32(seed);
  const graph = new Graph({ type: "directed", multi: false });
  for (let i = 0; i < nodeCount; i++) {
    graph.addNode(String(i), { size: 2, color: "#4f7cff" });
  }
  // Endpoint list: a node appears once per incident edge, so uniform sampling
  // from it is degree-proportional sampling.
  const endpoints: number[] = [];
  const link = (a: number, b: number) => {
    graph.addEdge(String(a), String(b));
    endpoints.push(a, b);
  };
  const seedSize = m + 1;
  for (let i = 0; i < seedSize; i++) {
    for (let j = i + 1; j < seedSize; j++) link(i, j);
  }
  for (let v = seedSize; v < nodeCount; v++) {
    const chosen = new Set<number>();
    while (chosen.size < m) {
      const t = endpoints[Math.floor(rnd() * endpoints.length)];
      if (t !== v) chosen.add(t);
    }
    for (const t of chosen) link(v, t);
  }
  return graph;
}
