// Benchmark for the Code Graph pipeline in Node (V8, not a webview): decode, kernel (WASM), ranking,
// view-model prep and the graphology build the renderer does. Prints a table; the only assertion is a very
// generous cap per size, so a regression to "minutes" fails but machine noise does not.
//   node --experimental-strip-types ui/screens/graph/bench/graph-bench.ts [1000 8000 30000 50000]
// The WebGL draw and the real WKWebView speed are NOT measured here (see the doc: needs a real window).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { decodeGraph } from "../decode.ts";
import { decodeKernelOutput, encodeKernelInput, toLayoutResult, WasmKernel } from "../kernel.ts";
import { buildAdjacency, edgeWeights } from "../filters.ts";
import { planLod, weightHistogram } from "../lod.ts";
import { searchNodes } from "../search.ts";
import { visibleNodes } from "../visibility.ts";
import { initialFilters } from "../filters.ts";
import { synthKitGraph } from "./synth.ts";

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
const SIZES = sizes.length ? sizes : [1000, 8000, 30000, 50000];
const CAP_MS = 240_000;
const requireDesktop = createRequire(new URL("../../../../desktop/package.json", import.meta.url));
const Graph = requireDesktop("graphology").default ?? requireDesktop("graphology");
const wasm = new Uint8Array(readFileSync(fileURLToPath(new URL("../wasm/graph-layout.wasm", import.meta.url))));

const ms = (t: number) => Math.round(performance.now() - t);
const mb = (b: number) => Math.round(b / 1048576);
const rows: Record<string, number | string>[] = [];

for (const n of SIZES) {
  const text = synthKitGraph({ nodes: n, edgesPerNode: 4 });
  const t0 = performance.now();
  let t = performance.now();
  const model = decodeGraph(text);
  const decode = ms(t);
  t = performance.now();
  const input = encodeKernelInput(model);
  const encode = ms(t);
  const kernel = await WasmKernel.create(wasm);
  t = performance.now();
  const raw = kernel.run(input);
  const run = ms(t);
  t = performance.now();
  const layout = toLayoutResult(decodeKernelOutput(raw, model.n), "wasm", run);
  const rank = ms(t);
  t = performance.now();
  const adj = buildAdjacency(model);
  const weights = edgeWeights(model);
  const hist = weightHistogram(weights);
  const prep = ms(t);
  t = performance.now();
  const plan = planLod(model.n, model.m, 1, hist);
  const vis = visibleNodes(model, layout, initialFilters(), plan, -1, adj);
  const lod = ms(t);
  t = performance.now();
  const hits = searchNodes(model, "file1");
  const search = ms(t);
  t = performance.now();
  const g = new Graph({ type: "directed", multi: false });
  for (let i = 0; i < model.n; i++) g.addNode(i, { x: layout.pos[2 * i], y: layout.pos[2 * i + 1], size: 2, i });
  const seen = new Set<number>();
  for (let e = 0; e < model.m; e++) {
    const key = model.from[e] * model.n + model.to[e];
    if (seen.has(key)) continue;
    seen.add(key);
    g.addDirectedEdgeWithKey(e, model.from[e], model.to[e], { e });
  }
  const build = ms(t);
  const total = ms(t0);
  rows.push({
    nodes: model.n, edges: model.m, json_mb: mb(text.length), decode, encode, kernel: run, rank, prep, lod, search, graphology: build,
    total, communities: layout.communityCount, shown_far: vis.reduce((a, b) => a + b, 0), hits: hits.length, rss_mb: mb(process.memoryUsage().rss),
  });
  g.clear();
  if (total > CAP_MS) {
    console.table(rows);
    console.error(`FAIL: ${n} nodes took ${total} ms (cap ${CAP_MS})`);
    process.exit(1);
  }
}
console.log("times in ms, Node " + process.version + ", " + process.platform + "/" + process.arch);
console.table(rows);
