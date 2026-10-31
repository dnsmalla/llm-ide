// Deterministic synthetic graph.json (graph-kit 1.1 shape) for tests and the benchmark: files in
// community-sized clusters, mostly intra-cluster imports, a few cross-cluster ones, and call records.
// Seeded (mulberry32), so every run builds the same bytes.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthOptions {
  nodes: number;
  /** Average edges per node (imports + calls). */
  edgesPerNode?: number;
  clusterSize?: number;
  seed?: number;
}

export function synthKitGraph({ nodes, edgesPerNode = 4, clusterSize = 60, seed = 7 }: SynthOptions): string {
  const rnd = mulberry32(seed);
  const paths: string[] = [];
  for (let i = 0; i < nodes; i++) {
    const c = Math.floor(i / clusterSize);
    paths.push(`src/pkg${c}/mod${i % clusterSize}/file${i}.ts`);
  }
  const imports: string[][] = Array.from({ length: nodes }, () => []);
  const calls: { from: string; to: string; symbol: string }[] = [];
  const total = nodes * edgesPerNode;
  for (let e = 0; e < total; e++) {
    const a = Math.floor(rnd() * nodes);
    const cluster = Math.floor(a / clusterSize);
    const cross = rnd() < 0.05;
    let b: number;
    if (cross) b = Math.floor(rnd() * nodes);
    else {
      // preferential attachment inside the cluster: low offsets are hubs
      const off = Math.floor(rnd() * rnd() * clusterSize);
      b = Math.min(nodes - 1, cluster * clusterSize + off);
    }
    if (a === b) continue;
    if (rnd() < 0.6) imports[a].push(paths[b]);
    else calls.push({ from: paths[a], to: paths[b], symbol: `fn${e % 97}` });
  }
  const files = paths.map((path, i) => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    language: "typescript",
    loc: 20 + (i % 400),
    role: i % 50 === 0 ? "entry" : "module",
    imports: imports[i],
    usedBy: [],
    types: [],
    functions: [],
  }));
  return JSON.stringify({ version: "1.1", summary: { totalFiles: nodes, totalEdges: 0, totalCalls: calls.length }, files, calls });
}
