import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGraph } from "../decode.ts";
import { runJob } from "../layout-job.ts";
import { EDGE_BUDGET, LABEL_BUDGET, NODE_BUDGET, WEIGHT_BUCKETS, planLod, weightHistogram } from "../lod.ts";
import { buildAdjacency, communitySummary, edgeWeights, initialFilters, kindAllowed, nodeMask } from "../filters.ts";
import { edgeShown, labelShown, visibleNodes } from "../visibility.ts";
import { fixedWindow, searchNodes } from "../search.ts";
import { communityColor } from "../colors.ts";
import { synthKitGraph } from "../bench/synth.ts";
import { loadWasmBytes } from "./wasm-helper.ts";

const flat = () => new Uint32Array(WEIGHT_BUCKETS);

test("LOD: a small graph is always shown in full at any zoom", () => {
  for (const ratio of [0.01, 0.5, 1, 4]) {
    const p = planLod(2000, 6000, ratio, weightHistogram(new Float32Array(6000).fill(0.9)));
    assert.equal(p.nodeFraction, 1);
    assert.equal(p.edgeFloor, 0);
    assert.equal(p.labelFraction >= LABEL_BUDGET / 2000, true);
  }
});

test("LOD: 50k nodes zoomed out reduce nodes by budget; zooming in brings them back", () => {
  const n = 50_000, m = 250_000;
  const w = new Float32Array(m);
  for (let i = 0; i < m; i++) w[i] = [0.9, 0.8, 0.6, 0.36, 0.24, 0.18][i % 6];
  const hist = weightHistogram(w);
  const far = planLod(n, m, 1, hist);
  assert.ok(far.nodeFraction <= NODE_BUDGET / n + 0.05, `far node fraction ${far.nodeFraction}`);
  assert.ok(far.nodeFraction < 1);
  assert.ok(far.edgeFloor > 0, "far: weakest edges hidden");
  const mid = planLod(n, m, 0.4, hist);
  assert.ok(mid.nodeFraction > far.nodeFraction);
  assert.ok(mid.edgeFloor <= far.edgeFloor);
  const near = planLod(n, m, 0.05, hist);
  assert.equal(near.nodeFraction, 1);
  assert.equal(near.edgeFloor, 0);
  // edges kept at the far plan never exceed the budget
  let kept = 0;
  for (const x of w) if (x >= far.edgeFloor - 1e-9) kept++;
  assert.ok(kept <= EDGE_BUDGET * 1.0001 || far.edgeFloor >= 1, `kept ${kept}`);
  // the plan key is coarse: tiny zoom changes do not change it
  assert.equal(planLod(n, m, 1, hist).key, planLod(n, m, 0.99, hist).key);
  assert.notEqual(far.key, near.key);
});

test("LOD: degenerate inputs are safe", () => {
  assert.equal(planLod(0, 0, 1, flat()).nodeFraction, 1);
  for (const r of [NaN, 0, -1, Infinity]) assert.ok(Number.isFinite(planLod(100_000, 500_000, r, flat()).nodeFraction));
  // all edges at the top bucket and over budget: floor above every weight hides all of them
  const h = flat(); h[100] = 1_000_000;
  assert.ok(planLod(100_000, 1_000_000, 1, h).edgeFloor >= 1);
  assert.equal(weightHistogram([1, 0, 0.3, 5, -2])[100], 2, "out-of-range weights clamp, not crash");
});

async function laidOut(n = 400) {
  const r = await runJob(synthKitGraph({ nodes: n, clusterSize: 40 }), { loadWasm: loadWasmBytes });
  return { model: r.model, layout: r.layout };
}

test("filters: preset, hidden kinds, community and weight; filters hide, never delete", async () => {
  const { model, layout } = await laidOut();
  const f = initialFilters();
  assert.equal(nodeMask(model, layout, f).reduce((a, b) => a + b, 0), model.n);
  assert.equal(kindAllowed("file", { ...f, preset: "docs" }), false);
  assert.equal(kindAllowed("memoryDoc", { ...f, preset: "docs" }), true);
  assert.equal(kindAllowed("file", { ...f, hiddenKinds: new Set(["file"]) }), false);
  const one = communitySummary(model, layout)[0];
  const m1 = nodeMask(model, layout, { ...f, community: one.id });
  assert.equal(m1.reduce((a, b) => a + b, 0), one.size);
  assert.equal(model.n, 400, "the model is untouched");
  const cs = communitySummary(model, layout);
  assert.ok(cs.every((c, i) => i === 0 || cs[i - 1].size >= c.size), "largest first");
  assert.equal(layout.community[cs[0].label], cs[0].id, "label node belongs to its community");
});

test("visibility: LOD thins nodes by community rank, selection and neighbours always stay, edges follow ends and weight", async () => {
  const { model, layout } = await laidOut();
  const adj = buildAdjacency(model);
  const weights = edgeWeights(model);
  const plan = { nodeFraction: 0.1, edgeFloor: 0.7, labelFraction: 0.05, key: "t" };
  const vis = visibleNodes(model, layout, initialFilters(), plan, -1, adj);
  const shown = vis.reduce((a, b) => a + b, 0);
  assert.ok(shown > 0 && shown < model.n * 0.5, `shown ${shown}`);
  for (const c of communitySummary(model, layout)) assert.equal(vis[c.label], 1, "every community keeps its top node");
  // pick a hidden node with at least one neighbour and select it
  let pick = -1;
  for (let i = 0; i < model.n; i++) if (vis[i] === 0 && adj.start[i + 1] > adj.start[i]) { pick = i; break; }
  assert.ok(pick >= 0);
  const vis2 = visibleNodes(model, layout, initialFilters(), plan, pick, adj);
  assert.equal(vis2[pick], 1);
  for (let k = adj.start[pick]; k < adj.start[pick + 1]; k++) assert.equal(vis2[adj.nbr[k]], 1);
  // a filtered-out node is hidden even when selected
  const hide = visibleNodes(model, layout, { ...initialFilters(), hiddenKinds: new Set(["file"]) }, plan, pick, adj);
  assert.equal(hide[pick], 0);
  // edges
  const all = new Uint8Array(model.n).fill(1);
  const flatPlan = { nodeFraction: 1, edgeFloor: 0, labelFraction: 1, key: "f" };
  let shownEdges = 0, lightShown = 0;
  for (let e = 0; e < model.m; e++) {
    if (edgeShown(e, model, weights, all, 0.3, flatPlan, -1)) shownEdges++;
    if (weights[e] < 0.3 && edgeShown(e, model, weights, all, 0.3, flatPlan, -1)) lightShown++;
  }
  assert.equal(lightShown, 0, "the slider hides weak edges");
  assert.ok(shownEdges > 0);
  const e0 = 0;
  const hid = new Uint8Array(model.n).fill(1); hid[model.from[e0]] = 0;
  assert.equal(edgeShown(e0, model, weights, hid, 0, flatPlan, -1), false, "an edge needs both ends drawn");
  assert.equal(edgeShown(e0, model, weights, all, 1.01, flatPlan, model.from[e0]), true, "the selection's own edges ignore the weight floor");
  assert.equal(labelShown(5, layout, plan, 5, false), true);
  assert.equal(labelShown(6, layout, plan, 5, true), true);
});

test("search: ranked exact > prefix > contains > path; empty and over-long queries; limit", () => {
  const model = decodeGraph(JSON.stringify({ files: [
    { path: "lib/other.ts", name: "other.ts" }, { path: "src/app.ts", name: "app.ts" }, { path: "src/app/index.ts", name: "index.ts" },
    { path: "src/myapp.ts", name: "myapp.ts" }, { path: "src/application.ts", name: "application.ts" }, { path: "docs/x.ts", name: "APP" },
  ] }));
  const r = Array.from(searchNodes(model, "app")).map((i) => model.titles[i]);
  assert.deepEqual(r, ["APP", "app.ts", "application.ts", "myapp.ts", "index.ts"]);
  assert.equal(searchNodes(model, "   ").length, 0);
  assert.equal(searchNodes(model, "x".repeat(10_000)).length, 0);
  assert.equal(searchNodes(model, "a", 2).length, 2);
});

test("search over 50k nodes is quick and windowing renders a constant number of rows", () => {
  const files = Array.from({ length: 50_000 }, (_, i) => ({ path: `p${i % 100}/file${i}.ts`, name: `file${i}.ts` }));
  const model = decodeGraph(JSON.stringify({ files }));
  const t = performance.now();
  const hits = searchNodes(model, "file4");
  assert.ok(performance.now() - t < 1500);
  assert.ok(hits.length > 1000);
  for (const top of [0, 12_345, hits.length * 30 - 400]) {
    const w = fixedWindow(hits.length, 30, top, 420);
    assert.ok(w.end - w.start <= 14 + 12 + 1, `rows ${w.end - w.start}`);
    assert.equal(w.padTop + (w.end - w.start) * 30 + w.padBottom, hits.length * 30);
  }
  assert.deepEqual(fixedWindow(0, 30, 0, 400), { start: 0, end: 0, padTop: 0, padBottom: 0 });
});

test("colours: stable, distinct for the first 8, valid for any id", () => {
  assert.equal(new Set(Array.from({ length: 8 }, (_, i) => communityColor(i))).size, 8);
  assert.match(communityColor(5000), /^hsl\(/);
  assert.equal(communityColor(3), communityColor(3));
});
