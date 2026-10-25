// Measurement only: ForceAtlas2 per-iteration cost in plain Node on the same
// 10k synthetic graph the Graph tab uses (same generator, seeds, and settings as
// src/graph/synthetic.ts, layout.ts). Compares iterations 1-10 with 40-50.
// Run: node scripts/fa2-node-bench.mjs   (from desktop/)
import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSyntheticGraph(nodeCount, m, seed) {
  const rnd = mulberry32(seed);
  const graph = new Graph({ type: "directed", multi: false });
  for (let i = 0; i < nodeCount; i++) graph.addNode(String(i), { size: 2, color: "#4f7cff" });
  const endpoints = [];
  const link = (a, b) => {
    graph.addEdge(String(a), String(b));
    endpoints.push(a, b);
  };
  const seedSize = m + 1;
  for (let i = 0; i < seedSize; i++) for (let j = i + 1; j < seedSize; j++) link(i, j);
  for (let v = seedSize; v < nodeCount; v++) {
    const chosen = new Set();
    while (chosen.size < m) {
      const t = endpoints[Math.floor(rnd() * endpoints.length)];
      if (t !== v) chosen.add(t);
    }
    for (const t of chosen) link(v, t);
  }
  return graph;
}

function seedPositions(graph, seed) {
  const rnd = mulberry32(seed);
  graph.updateEachNodeAttributes((_node, attr) => ({
    ...attr,
    x: (rnd() * 2 - 1) * 100,
    y: (rnd() * 2 - 1) * 100,
  }));
}

const graph = buildSyntheticGraph(10_000, 3, 10_000);
seedPositions(graph, 10_001);
const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: true };

// assign() runs N iterations from the current positions, so consecutive calls
// continue the same layout. Timing 10 iterations after 30 untimed ones gives
// iterations 40-50.
const t1 = performance.now();
forceAtlas2.assign(graph, { iterations: 10, settings });
const first10 = (performance.now() - t1) / 10;
forceAtlas2.assign(graph, { iterations: 30, settings });
const t2 = performance.now();
forceAtlas2.assign(graph, { iterations: 10, settings });
const iter40_50 = (performance.now() - t2) / 10;

console.log(`fa2_node_ms_per_iter_first10 ${first10.toFixed(1)}`);
console.log(`fa2_node_ms_per_iter_iter40_50 ${iter40_50.toFixed(1)}`);
