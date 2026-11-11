import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("empty state gives the Mac's three-mode message and no preset controls", () => {
  const out = html(h(G.EmptyState, { mode: "code" }));
  assert.match(out, /No code graph yet/);
  assert.match(out, /Generate Code Graph/);
  assert.doesNotMatch(out, /Scan folder|Open another graph|Mode/);
  assert.match(html(h(G.EmptyState, { mode: "memory" })), /No InfiniteBrain graph yet/);
  assert.match(html(h(G.EmptyState, { mode: "all" })), /No graph yet/);
});

test("too large, no project, loading and error states are announced and have a next step", () => {
  assert.match(html(h(G.TooLargeState, { onOpen: () => true })), /128 MB limit[\s\S]*GRAPH_FILE_MAX_BYTES/);
  assert.match(html(h(G.NoProjectState)), /Open or create a project to see the code graph/);
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
  assert.match(out, />Open<\/button>/);
  assert.match(out, /Neighbours \(/);
  assert.match(out, /weight 0\.\d\d/);
  const noPath = html(h(G.NodeDetails, { model, layout, adj, node, onSelect: noop, onOpenFile: null, onClose: noop }));
  assert.doesNotMatch(noPath, />Open<\/button>/);
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
  assert.match(render(e), /No code graph yet/);
  const n = mk(async () => ""); await n.load(null);
  assert.match(render(n), /Open or create a project to see the code graph/);
  const t = mk(async () => { throw new Error("graph.json is not a regular file within the size limit"); }); await t.load("/p");
  assert.match(render(t), /128 MB limit/);
  const bad = mk(async () => "{}"); await bad.load("/p");
  assert.match(render(bad), /could not be shown/);
  assert.match(render(mk(async () => "")), /Loading the code graph/);
});

test("a cancelled load offers Reload instead of a spinner; too-large and error keep the generate controls", async () => {
  const mk = (invoke) => new G.GraphStore({ invoke, engine: { cancel() {}, async load() { return { kind: "error", message: "unused" }; } } });
  const render = (store) => html(h(G.GraphScreen, { store, active: true, projectRoot: "/p", openFile: noop, onGenerate: async () => {} }));
  const pending = mk(() => new Promise(() => {}));
  void pending.load("/p");
  pending.cancel();
  const cancelled = render(pending);
  assert.match(cancelled, /Loading was cancelled/);
  assert.match(cancelled, />Reload</);
  assert.doesNotMatch(cancelled, /Working/);
  const t = mk(async () => { throw new Error("graph.json is not a regular file within the size limit"); }); await t.load("/p");
  const tooLarge = render(t);
  assert.match(tooLarge, /128 MB limit/);
  assert.match(tooLarge, /Generate Code Graph/, "a too-large graph can be regenerated from here");
  assert.match(tooLarge, /Open graph\.json/);
  const bad = mk(async () => "{}"); await bad.load("/p");
  const broken = render(bad);
  assert.match(broken, /could not be shown/);
  assert.match(broken, /Generate Code Graph/, "a corrupt graph can be regenerated from here");
  assert.match(broken, /Try again/);
});

test("fallback layout is announced in the screen", async () => {
  const store = await ready(60);
  const entry = store.getSnapshot().entry;
  entry.layout.engine = "fallback";
  assert.match(html(h(G.GraphScreen, { store, active: true, projectRoot: "/p", openFile: noop })), /simplified layout/);
});

// Parity with the Mac (CodeGraphView): Symbols defaults off, the toolbar counts shown nodes and the code / doc split,
// the focus pill appears, and a generate button with no scan target is disabled.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");
async function loaded(text) {
  const engine = { cancel() {}, async load() { const r = await G.runJob(text, { loadWasm: G.loadWasmBytes }); return { kind: "done", entry: { model: r.model, layout: r.layout, notices: r.notices }, cached: false }; } };
  const store = new G.GraphStore({ invoke: async () => text, engine });
  await store.load("/proj");
  return store;
}

test("parity: a code graph opens with Symbols off, shows shown / total, and disables generate with no scan target", async () => {
  const store = await loaded(fixture("merge-code"));
  const screen = () => html(h(G.GraphScreen, { store, active: true, projectRoot: "/proj", openFile: noop, onGenerate: async () => {} }));
  const out = screen();
  assert.match(out, /aria-pressed="false"[^>]*>Symbols<\/button>/, "Symbols is off on open, as on the Mac");
  assert.match(out, /aria-label="Nodes shown">[\d,]+ \/ [\d,]+ shown</);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Generate Code Graph<\/button>/, "no repo in SSR, so generate is disabled");
  store.setFocus(0);
  assert.match(screen(), /Focus: [^<]+ ✕<\/button>/, "a focused node shows the focus pill");
  store.setFocus(-1);
  assert.doesNotMatch(screen(), /Focus: /);
});

test("parity: an InfiniteBrain graph has no Symbols toggle and reports its doc count", async () => {
  const store = await loaded(fixture("memory"));
  const out = html(h(G.GraphScreen, { store, active: true, projectRoot: "/proj", openFile: noop }));
  assert.doesNotMatch(out, />Symbols<\/button>/);
  assert.match(out, /nodes, [\d,]+ edges, \d+ communities · [\d,]+ code · [\d,]+ doc/);
});

test("parity: the kind legend and kind checkboxes use the Mac's palette", async () => {
  const store = await loaded(fixture("merge-code"));
  const { model } = store.getSnapshot().entry;
  const out = html(h(G.Controls, { model, communities: G.communitySummary(store.getSnapshot().entry.model, store.getSnapshot().entry.layout), filters: store.getSnapshot().filters, onChange: noop }));
  assert.match(out, /background:#007aff/, "file is the Mac's blue");
  assert.match(out, /background:#3399e6/, "function is the Mac's code blue");
});

test("parity: a missing file is named as missing; other read errors are shown as they came", () => {
  assert.equal(G.isMissingFile("cannot resolve code/x.ts: No such file or directory"), true);
  assert.equal(G.isMissingFile("file not found"), true);
  assert.equal(G.isMissingFile("permission denied"), false);
});

test("review: a Tauri rejection ({ code, message }) is decoded; not_found reads as missing, permission errors do not", () => {
  assert.equal(G.readFailure({ code: "not_found", message: "cannot resolve path: No such file or directory (os error 2)" }), "not_found");
  assert.equal(G.isMissingFile(G.readFailure({ code: "not_found", message: "x" })), true);
  const denied = G.readFailure({ code: "permission_denied", message: "cannot resolve path: Permission denied (os error 13)" });
  assert.equal(denied, "cannot resolve path: Permission denied (os error 13)");
  assert.equal(G.isMissingFile(denied), false, "a permission error is not offered as a missing file");
  assert.equal(G.readFailure(new Error("boom")), "boom");
  assert.equal(G.readFailure(undefined), "The file could not be read.");
});
