import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadEntry, react, server } from "./helpers.mjs";

let G, h, html;
before(async () => {
  G = await loadEntry();
  h = react().createElement;
  html = (el) => server().renderToStaticMarkup(el);
});

const count = (s, re) => (s.match(re) ?? []).length;
const noop = () => {};

async function ready(nodes = 300, extra = {}) {
  const text = G.synthKitGraph({ nodes, clusterSize: 30 });
  const engine = { cancel() {}, async load() { const r = await G.runJob(text, { loadWasm: G.loadWasmBytes }); return { kind: "done", entry: { model: r.model, layout: r.layout, notices: r.notices }, cached: false }; } };
  const store = new G.GraphStore({ invoke: async () => text, engine, ...extra });
  await store.load("/proj");
  return store;
}

test("empty state explains how to get a graph, names the file, offers a labelled open field, never a command to run", () => {
  const out = html(h(G.EmptyState, { tried: ["system/graph/graph.json"], onOpen: () => true, onRetry: noop }));
  assert.match(out, /No code graph for this project yet/);
  assert.match(out, /system\/graph\/graph\.json/);
  assert.match(out, /macOS app/);
  assert.match(out, /<label[^>]*>[\s\S]*Open another graph\.json/);
  assert.match(out, /Check again/);
  assert.doesNotMatch(out, /npm |sudo |<script/);
});

test("too large, no project, loading and error states are announced and have a next step", () => {
  assert.match(html(h(G.TooLargeState, { onOpen: () => true })), /32 MB limit[\s\S]*GRAPH_FILE_MAX_BYTES/);
  assert.match(html(h(G.NoProjectState)), /Open a project first/);
  const l = html(h(G.LoadingState, { stage: "Laying out the graph", onCancel: noop }));
  assert.match(l, /role="status"[^>]*aria-live="polite"/);
  assert.match(l, />Cancel</);
  const e = html(h(G.ErrorState, { message: "<img src=x onerror=alert(1)>", onRetry: noop }));
  assert.match(e, /role="alert"/);
  assert.match(e, /&lt;img src=x/, "error text is escaped");
  assert.doesNotMatch(e, /<img/);
});

test("NodeList virtualises: 50,000 rows render a screenful, with listbox semantics", async () => {
  const store = await ready(400);
  const { model, layout } = store.getSnapshot().entry;
  // pretend there are 50,000 rows over the same node set
  const out = html(h(G.NodeList, { id: "t", label: "All nodes", model, layout, count: 50_000, nodeAt: (k) => k % model.n, selected: 3, onSelect: noop, initialViewport: 420 }));
  assert.match(out, /role="listbox"[^>]*aria-label="All nodes"/);
  assert.match(out, /aria-activedescendant="t-r0"/);
  const rows = count(out, /role="option"/g);
  assert.ok(rows > 10 && rows < 40, `rows ${rows}`);
  assert.match(out, /aria-setsize="50000"/);
  assert.match(out, /aria-posinset="1"/);
  assert.match(out, /aria-selected="true"/);
  assert.match(out, /padding-bottom:\s*\d{5,}px/, "the unrendered rows are a spacer, not DOM");
  const empty = html(h(G.NodeList, { id: "e", label: "Search results", model, layout, count: 0, nodeAt: () => 0, selected: -1, onSelect: noop, emptyText: "No node matches." }));
  assert.match(empty, /role="status"[^>]*>No node matches\./);
  assert.doesNotMatch(empty, /aria-activedescendant/);
});

test("labels from the file are text only: markup in a title is escaped in the list and the details", async () => {
  const text = JSON.stringify({ files: [{ path: "a.ts", name: "<img src=x onerror=alert(1)>", imports: ["b.ts"], language: "<b>ts</b>" }, { path: "b.ts", name: "\"><script>x()</script>" }] });
  const r = await G.runJob(text, { loadWasm: G.loadWasmBytes });
  const adj = G.buildAdjacency(r.model);
  const list = html(h(G.NodeList, { id: "x", label: "n", model: r.model, layout: r.layout, count: 2, nodeAt: (k) => k, selected: -1, onSelect: noop }));
  const det = html(h(G.NodeDetails, { model: r.model, layout: r.layout, adj, node: 0, onSelect: noop, onOpenFile: noop, onClose: noop }));
  for (const out of [list, det]) {
    assert.doesNotMatch(out, /<img|<script|<b>/);
    assert.match(out, /&lt;img src=x/);
  }
  assert.match(det, /&lt;b&gt;ts&lt;\/b&gt;/, "metadata is text too");
});

test("details: facts, neighbours with weights, Open in Explorer only when there is a project-relative path", async () => {
  const store = await ready(120);
  const { model, layout } = store.getSnapshot().entry;
  const adj = G.buildAdjacency(model);
  let node = 0;
  while (adj.start[node + 1] === adj.start[node]) node++;
  const opened = [];
  const out = html(h(G.NodeDetails, { model, layout, adj, node, onSelect: noop, onOpenFile: (p) => opened.push(p), onClose: noop }));
  assert.match(out, /<aside[^>]*aria-label="Details for /);
  assert.match(out, /<dt>Kind<\/dt><dd>file<\/dd>/);
  assert.match(out, /Open in Explorer/);
  assert.match(out, /Neighbours \(/);
  assert.match(out, /weight 0\.\d\d/);
  const noPath = html(h(G.NodeDetails, { model, layout, adj, node, onSelect: noop, onOpenFile: null, onClose: noop }));
  assert.doesNotMatch(noPath, /Open in Explorer/);
});

test("controls: radiogroup for the mode, labelled slider, kind checkboxes, community select", async () => {
  const store = await ready(200);
  const s = store.getSnapshot();
  const out = html(h(G.Controls, { model: s.entry.model, communities: G.communitySummary(s.entry.model, s.entry.layout), filters: s.filters, onChange: noop }));
  assert.match(out, /role="radiogroup" aria-label="Graph mode"/);
  assert.equal(count(out, /role="radio"/g), 3);
  assert.match(out, /aria-checked="true"[^>]*data-on="true">All</);
  assert.match(out, /Minimum edge weight: 0\.30/);
  assert.match(out, /<input type="range"/);
  assert.match(out, /<legend>Node kinds<\/legend>/);
  assert.match(out, /<option value=""[^>]*>All communities<\/option>/);
});

test("screen: tabs with ARIA, summary line, canvas group with keyboard help, details only on selection", async () => {
  const store = await ready(250);
  const screen = (props = {}) => html(h(G.GraphScreen, { store, active: true, projectRoot: "/proj", openFile: noop, ...props }));
  const out = screen();
  assert.match(out, /role="tablist" aria-label="Graph views"/);
  assert.match(out, /role="tab"[^>]*aria-selected="true"[^>]*aria-controls="gr-panel-graph"/);
  assert.match(out, /role="tabpanel"[^>]*aria-labelledby="gr-tab-list"[^>]*hidden/);
  assert.match(out, /250 nodes, [\d,]+ edges, \d+ communities/);
  assert.match(out, /role="group"[^>]*aria-label="Code graph canvas\. Arrow keys pan/);
  assert.match(out, /tabindex="0"/);
  assert.match(out, /aria-label="Zoom in"/);
  assert.doesNotMatch(out, /<aside/);
  store.select(5);
  assert.match(screen(), /<aside[^>]*aria-label="Details for /);
  store.setTab("list");
  const list = screen();
  assert.match(list, /role="listbox"[^>]*aria-label="All nodes"/);
  assert.match(list, /id="gr-panel-list"[^>]*role="tabpanel"|role="tabpanel"[^>]*id="gr-panel-list"/);
  store.setQuery("file1");
  const searched = screen();
  assert.match(searched, /matches?<\/p>/);
  assert.match(searched, /aria-label="Search results"/);
});

test("screen states by phase: empty, no project, too large, error, loading", async () => {
  const mk = (invoke) => new G.GraphStore({ invoke, engine: { cancel() {}, async load() { return { kind: "error", message: "unused" }; } } });
  const render = (store) => html(h(G.GraphScreen, { store, active: true, projectRoot: "/p", openFile: noop }));
  const e = mk(async () => { throw new Error("cannot resolve x: No such file"); });
  await e.load("/p");
  assert.match(render(e), /No code graph for this project yet/);
  const n = mk(async () => ""); await n.load(null);
  assert.match(render(n), /Open a project first/);
  const t = mk(async () => { throw new Error("graph.json is not a regular file within the size limit"); }); await t.load("/p");
  assert.match(render(t), /32 MB limit/);
  const bad = mk(async () => "{}"); await bad.load("/p");
  assert.match(render(bad), /could not be shown/);
  assert.match(render(mk(async () => "")), /Loading the code graph/);
});

test("fallback layout is announced in the screen", async () => {
  const store = await ready(60);
  const entry = store.getSnapshot().entry;
  entry.layout.engine = "fallback";
  assert.match(html(h(G.GraphScreen, { store, active: true, projectRoot: "/p", openFile: noop })), /simplified layout/);
});
