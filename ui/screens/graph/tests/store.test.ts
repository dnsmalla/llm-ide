import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphStore, type StoreDeps } from "../store.ts";
import { classifyReadError, customGraphPath, graphCandidates, joinRoot, readProjectGraph, GRAPH_CANDIDATES } from "../source.ts";
import type { JobOutcome } from "../engine.ts";
import type { CacheEntry } from "../cache.ts";
import { runJob } from "../layout-job.ts";
import { loadWasmBytes } from "./wasm-helper.ts";

const GOOD = JSON.stringify({ files: [{ path: "a.ts", imports: ["b.ts"] }, { path: "b.ts" }] });

function deps(files: Record<string, string | Error>, log: string[] = []) {
  const engine = {
    cancels: 0,
    cancel() { this.cancels++; },
    async load(text: string, onProgress?: (s: "hash" | "decode" | "layout") => void): Promise<JobOutcome> {
      onProgress?.("hash"); onProgress?.("decode"); onProgress?.("layout");
      try {
        const r = await runJob(text, { loadWasm: loadWasmBytes });
        return { kind: "done", entry: { model: r.model, layout: r.layout, notices: r.notices }, cached: false };
      } catch (e) { return { kind: "error", message: (e as Error).message }; }
    },
  };
  const invoke: StoreDeps["invoke"] = async (cmd, args) => {
    log.push(`${cmd}:${(args as { path: string }).path}`);
    const v = files[(args as { path: string }).path];
    if (v === undefined) throw new Error(`cannot resolve ${(args as { path: string }).path}: No such file or directory (os error 2)`);
    if (v instanceof Error) throw v;
    return v;
  };
  return { invoke, engine };
}

test("read errors are classified; custom paths must be project-relative graph.json", () => {
  assert.equal(classifyReadError("cannot resolve /x: No such file"), "not-found");
  assert.equal(classifyReadError("graph.json is not a regular file within the size limit"), "too-large");
  assert.equal(classifyReadError("no project root configured"), "no-project");
  assert.equal(classifyReadError("path is outside the project root"), "error");
  assert.equal(customGraphPath(" system/graph/graph.json "), "system/graph/graph.json");
  for (const bad of ["", "../graph.json", "/abs/graph.json", "x/other.json", "graph.json/x", "a\0/graph.json"]) assert.equal(customGraphPath(bad), null, bad);
  assert.equal(customGraphPath("graph.json"), "graph.json");
  assert.equal(customGraphPath("system/graph/graph-memory.json"), "system/graph/graph-memory.json");
  assert.equal(customGraphPath("system/graph/graph-all.json"), "system/graph/graph-all.json");
  assert.equal(customGraphPath("system/graph/other.json"), null);
  assert.equal(joinRoot("/p/", "a/b"), "/p/a/b");
});

test("readProjectGraph tries the candidates in order and does not mask a real failure", async () => {
  const log: string[] = [];
  const d = deps({ "/p/system/graph.json": GOOD }, log);
  const r = await readProjectGraph(d.invoke, "/p");
  assert.deepEqual(log, ["read_graph_file:/p/system/graph/graph.json", "read_graph_file:/p/system/graph.json"]);
  assert.equal(r.ok && r.path, "system/graph.json");
  const big = deps({ "/p/system/graph/graph.json": new Error("graph.json is not a regular file within the size limit"), "/p/system/graph.json": GOOD });
  const r2 = await readProjectGraph(big.invoke, "/p");
  assert.equal(!r2.ok && r2.kind, "too-large");
  const none = await readProjectGraph(deps({}).invoke, "/p");
  assert.equal(!none.ok && none.kind, "not-found");
  assert.deepEqual(!none.ok && none.tried, [...GRAPH_CANDIDATES]);
  const nr = await readProjectGraph(deps({}).invoke, null);
  assert.equal(!nr.ok && nr.kind, "no-project");
  const notText = await readProjectGraph(async () => 5, "/p");
  assert.equal(!notText.ok && notText.kind, "error");
});

test("store: ready, empty (no graph yet), too-large, no-project, error; state transitions are observable", async () => {
  const seen: string[] = [];
  const ok = new GraphStore(deps({ "/p/system/graph/graph.json": GOOD }));
  ok.subscribe(() => seen.push(ok.getSnapshot().phase));
  await ok.load("/p");
  assert.equal(ok.getSnapshot().phase, "ready");
  assert.equal(ok.getSnapshot().entry?.model.n, 2);
  assert.equal(ok.getSnapshot().sourcePath, "system/graph/graph.json");
  assert.deepEqual([...new Set(seen)], ["loading", "ready"]);

  const empty = new GraphStore(deps({}));
  await empty.load("/p");
  assert.equal(empty.getSnapshot().phase, "empty");
  assert.deepEqual(empty.getSnapshot().tried, [...GRAPH_CANDIDATES]);

  const big = new GraphStore(deps({ "/p/system/graph/graph.json": new Error("graph.json is not a regular file within the size limit") }));
  await big.load("/p");
  assert.equal(big.getSnapshot().phase, "too-large");

  const np = new GraphStore(deps({}));
  await np.load(null);
  assert.equal(np.getSnapshot().phase, "no-project");

  const bad = new GraphStore(deps({ "/p/system/graph/graph.json": "not json" }));
  await bad.load("/p");
  assert.equal(bad.getSnapshot().phase, "error");
  assert.match(bad.getSnapshot().error ?? "", /not valid JSON/);

  const zero = new GraphStore(deps({ "/p/system/graph/graph.json": JSON.stringify({ files: [] }) }));
  await zero.load("/p");
  assert.equal(zero.getSnapshot().phase, "empty");
});

test("store: selection is bounds-checked, filters and query update, a new graph resets view state", async () => {
  const s = new GraphStore(deps({ "/p/system/graph/graph.json": GOOD }));
  await s.load("/p");
  s.select(1); assert.equal(s.getSnapshot().selected, 1);
  s.select(2); assert.equal(s.getSnapshot().selected, -1);
  s.select(1.5); assert.equal(s.getSnapshot().selected, -1);
  s.select(-5); assert.equal(s.getSnapshot().selected, -1);
  s.setFilters({ minWeight: 0.9 }); assert.equal(s.getSnapshot().filters.minWeight, 0.9);
  s.setQuery("x".repeat(500)); assert.equal(s.getSnapshot().query.length, 200);
  s.setTab("list"); assert.equal(s.getSnapshot().tab, "list");
  s.select(0);
  await s.reload();
  assert.equal(s.getSnapshot().selected, -1);
  assert.equal(s.getSnapshot().filters.minWeight, 0.3);
});

test("store: openPath validates before reading; a newer load wins over a slower older one; dispose cancels", async () => {
  const log: string[] = [];
  const s = new GraphStore(deps({ "/p/other/graph.json": GOOD }, log));
  s.getSnapshot();
  await s.load("/p");
  assert.equal(s.openPath("../escape/graph.json"), false);
  assert.equal(s.openPath("notgraph.txt"), false);
  assert.equal(s.openPath("other/graph.json"), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.getSnapshot().phase, "ready");
  assert.equal(s.getSnapshot().sourcePath, "other/graph.json");
  assert.ok(!log.some((l) => l.includes("escape")), "an invalid path never reaches the host");

  // race: first read resolves late
  let release!: (v: string) => void;
  const slow = new GraphStore({
    engine: deps({}).engine,
    invoke: async (_c, a) => ((a as { path: string }).path.startsWith("/slow") ? new Promise<string>((r) => { release = r; }) : GOOD),
  });
  const first = slow.load("/slow");
  await new Promise((r) => setTimeout(r, 0));
  const second = slow.load("/fast");
  await second;
  release(JSON.stringify({ files: [{ path: "z.ts" }] }));
  await first;
  assert.equal(slow.getSnapshot().entry?.model.n, 2, "the stale load did not overwrite the newer one");

  const d = deps({ "/p/system/graph/graph.json": GOOD });
  const st = new GraphStore(d);
  st.dispose();
  assert.ok(d.engine.cancels >= 1);
});

test("store.cancel during loading goes to cancelled (not a spinner), and a later load recovers", async () => {
  let release!: (v: string) => void;
  let reads = 0;
  const st = new GraphStore({ engine: deps({}).engine, invoke: () => (reads++ === 0 ? new Promise<string>((r) => { release = r; }) : Promise.resolve(GOOD)) });
  const p = st.load("/p");
  st.cancel();
  assert.equal(st.getSnapshot().phase, "cancelled");
  release(GOOD);
  await p;
  assert.equal(st.getSnapshot().phase, "cancelled", "a late read does not overwrite the cancelled state");
  await st.reload();
  assert.equal(st.getSnapshot().phase, "ready");
});

test("store.refresh: unchanged file does no work; changed file keeps the graph and view state on screen", async () => {
  let engineCalls = 0;
  let text = GOOD;
  let release!: () => void;
  let preview = true;
  const engine = {
    cancel() {},
    async load(t: string, _p?: unknown, onPreview?: (p: unknown) => void): Promise<JobOutcome> {
      engineCalls++;
      const r = await runJob(t, { loadWasm: loadWasmBytes });
      const entry = { model: r.model, layout: r.layout, notices: r.notices };
      if (preview) onPreview?.(entry);
      await new Promise<void>((res) => { release = res; });
      return { kind: "done", entry, cached: false };
    },
  };
  const s = new GraphStore({ invoke: async () => text, engine: engine as never });
  const first = s.load("/p");
  await new Promise((res) => setTimeout(res, 5));
  release();
  await first;
  s.select(1);
  s.setFilters({ minWeight: 0.7 });
  s.setQuery("a");
  const before = s.getSnapshot();
  await s.refresh("/p");
  assert.equal(engineCalls, 1, "same bytes: the layout is not asked again");
  assert.equal(s.getSnapshot(), before, "same bytes: no state change at all");

  text = JSON.stringify({ files: [{ path: "a.ts", imports: ["b.ts"] }, { path: "b.ts" }, { path: "c.ts" }] });
  preview = false;
  const refreshing = s.refresh("/p");
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(s.getSnapshot().phase, "ready", "the old graph stays on screen while the new one loads");
  assert.equal(s.getSnapshot().entry?.model.n, 2, "the old graph is still the one on screen");
  assert.equal(s.getSnapshot().filters.minWeight, 0.7, "view state is kept during a refresh");
  assert.equal(s.getSnapshot().query, "a");
  release();
  await refreshing;
  assert.equal(s.getSnapshot().entry?.model.n, 3);
  assert.equal(s.getSnapshot().filters.minWeight, 0.7);
  assert.equal(s.getSnapshot().query, "a");
  assert.equal(s.getSnapshot().selected, -1, "a changed graph clears the selection");
});

test("store.refresh with nothing on screen is an ordinary load; a failed refresh keeps the graph and says so", async () => {
  const s = new GraphStore(deps({ "/p/system/graph/graph.json": GOOD }));
  await s.refresh("/p");
  assert.equal(s.getSnapshot().phase, "ready", "no entry yet: the refresh loads it");
  const d = deps({ "/p/system/graph/graph.json": GOOD });
  let fail = false;
  const invoke: StoreDeps["invoke"] = async (c, a) => {
    if (fail) throw new Error("Permission denied (os error 13)");
    return d.invoke(c, a);
  };
  const flaky = new GraphStore({ engine: d.engine, invoke });
  await flaky.load("/p");
  fail = true;
  await flaky.refresh("/p");
  assert.equal(flaky.getSnapshot().phase, "ready");
  assert.equal(flaky.getSnapshot().entry?.model.n, 2, "the graph on screen is kept");
  assert.match(flaky.getSnapshot().error ?? "", /could not be refreshed/);
});


test("store: a preview shows the graph at once (refining), the final layout replaces it and keeps the user's view state", async () => {
  const r = await runJob(GOOD, { loadWasm: loadWasmBytes });
  const entry = { model: r.model, layout: r.layout, notices: [] as string[] };
  let finish!: () => void;
  const engine = {
    cancel() {},
    async load(_t: string, _p?: unknown, onPreview?: (p: typeof entry) => void): Promise<JobOutcome> {
      onPreview?.({ ...entry, layout: { ...entry.layout, engine: "fallback" } });
      await new Promise<void>((res) => { finish = res; });
      return { kind: "done", entry, cached: false };
    },
  };
  const s = new GraphStore({ invoke: async () => GOOD, engine });
  const p = s.load("/p");
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(s.getSnapshot().phase, "ready");
  assert.equal(s.getSnapshot().refining, true);
  assert.equal(s.getSnapshot().entry?.layout.engine, "fallback");
  s.select(1);
  s.setFilters({ minWeight: 0.7 });
  finish();
  await p;
  assert.equal(s.getSnapshot().refining, false);
  assert.equal(s.getSnapshot().entry?.layout.engine, "wasm");
  assert.equal(s.getSnapshot().selected, 1, "selection survives the swap");
  assert.equal(s.getSnapshot().filters.minWeight, 0.7);
});

test("store: the full layout failing after a preview keeps the preview and says so", async () => {
  const r = await runJob(GOOD, { loadWasm: loadWasmBytes });
  const entry = { model: r.model, layout: r.layout, notices: [] as string[] };
  const engine = {
    cancel() {},
    async load(_t: string, _p?: unknown, onPreview?: (p: typeof entry) => void): Promise<JobOutcome> {
      onPreview?.(entry);
      return { kind: "error", message: "worker died" };
    },
  };
  const s = new GraphStore({ invoke: async () => GOOD, engine });
  await s.load("/p");
  assert.equal(s.getSnapshot().phase, "ready");
  assert.match(s.getSnapshot().error ?? "", /full layout failed \(worker died\)/);
});


test("graphCandidates: each mode has its own file, and code still falls back to the legacy graph.json", () => {
  assert.deepEqual(graphCandidates("code"), ["system/graph/graph-code.json", ...GRAPH_CANDIDATES]);
  assert.deepEqual(graphCandidates("memory"), ["system/graph/graph-memory.json"]);
  assert.deepEqual(graphCandidates("all"), ["system/graph/graph-all.json"]);
});


test("revealNode unhides a searched kind and clears a community/preset filter", async () => {
  const d = deps({ "/p/system/graph/graph.json": GOOD });
  const store = new GraphStore(d);
  await store.load("/p");
  const entry = store.getSnapshot().entry!;
  const kind = entry.model.nodeKinds[entry.model.kindOf[0]];
  store.setFilters({ hiddenKinds: new Set([kind]), preset: "docs", community: 3 });
  store.revealNode(0);
  assert.equal(store.getSnapshot().selected, 0);
  assert.equal(store.getSnapshot().filters.hiddenKinds.has(kind), false);
  assert.equal(store.getSnapshot().filters.preset, "all");
  assert.equal(store.getSnapshot().filters.community, null);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return true;
    await sleep(5);
  }
  return false;
}

async function previewOf(text: string): Promise<CacheEntry> {
  const r = await runJob(text, { loadWasm: loadWasmBytes });
  return { model: r.model, layout: r.layout, notices: r.notices };
}

/** A layout that keeps running until the test finishes it, as the worker does; cancel() settles it as cancelled. */
function gatedEngine() {
  const state = { loads: 0, pending: null as ((o: JobOutcome) => void) | null, lastText: "" };
  const engine = {
    cancel(): void {
      const settle = state.pending;
      state.pending = null;
      settle?.({ kind: "cancelled" });
    },
    async load(text: string, _progress?: unknown, onPreview?: (p: CacheEntry) => void): Promise<JobOutcome> {
      state.loads++;
      state.lastText = text;
      onPreview?.(await previewOf(text));
      return new Promise<JobOutcome>((settle) => { state.pending = settle; });
    },
  };
  const finish = async (): Promise<void> => {
    const settle = state.pending;
    state.pending = null;
    settle?.({ kind: "done", entry: await previewOf(state.lastText), cached: false });
  };
  return { engine, state, finish };
}

test("store.refresh with identical bytes during a refining preview runs the layout again instead of stranding refining", async () => {
  const g = gatedEngine();
  const s = new GraphStore({ invoke: async () => GOOD, engine: g.engine as never });
  const first = s.load("/p");
  assert.ok(await waitFor(() => g.state.pending !== null), "the preview layout is running");
  assert.equal(s.getSnapshot().refining, true);
  const refreshing = s.refresh("/p");
  assert.ok(await waitFor(() => g.state.pending !== null && g.state.loads === 2), "the refresh started a fresh layout");
  assert.equal(s.getSnapshot().refining, true);
  await g.finish();
  await Promise.all([first, refreshing]);
  assert.equal(s.getSnapshot().refining, false, "the final layout clears refining");
  assert.equal(s.getSnapshot().phase, "ready");
  assert.equal(s.getSnapshot().error, null);
});

test("store.refresh with unchanged bytes clears the error a failed refresh left behind", async () => {
  const d = deps({ "/p/system/graph/graph.json": GOOD });
  let fail = false;
  const invoke: StoreDeps["invoke"] = async (c, a) => {
    if (fail) throw new Error("Permission denied (os error 13)");
    return d.invoke(c, a);
  };
  const s = new GraphStore({ engine: d.engine, invoke });
  await s.load("/p");
  fail = true;
  await s.refresh("/p");
  assert.match(s.getSnapshot().error ?? "", /could not be refreshed/);
  fail = false;
  await s.refresh("/p");
  assert.equal(s.getSnapshot().error, null, "the file reads again, so the stale error goes");
  assert.equal(s.getSnapshot().phase, "ready");
  assert.equal(s.getSnapshot().entry?.model.n, 2);
});

test("store.refresh that changes the graph drops a community the new layout lacks and hides symbol kinds it gained while Symbols is off", async () => {
  const doc = (kinds: string[]) => JSON.stringify({
    nodes: [{ id: "n0", kind: "file", title: "f" }, ...kinds.map((k, i) => ({ id: `k${i}`, kind: k, title: k }))],
    edges: [],
  });
  let text = doc(["symbol"]);
  const s = new GraphStore({ invoke: async () => text, engine: deps({}).engine as never });
  await s.load("/p");
  assert.equal(s.getSnapshot().filters.hiddenKinds.has("symbol"), true, "Symbols is off on open");
  s.setFilters({ community: 50 });
  text = doc(["symbol", "function"]);
  await s.refresh("/p");
  const f = s.getSnapshot().filters;
  assert.equal(s.getSnapshot().entry?.model.n, 3);
  assert.equal(f.community, null, "a community the new layout does not have is cleared");
  assert.equal(f.hiddenKinds.has("function"), true, "a symbol kind the graph gained stays hidden while Symbols is off");
  assert.equal(f.hiddenKinds.has("symbol"), true);

  s.setFilters({ hiddenKinds: new Set() });
  text = doc(["symbol", "function", "classType"]);
  await s.refresh("/p");
  assert.equal(s.getSnapshot().filters.hiddenKinds.has("classType"), false, "with Symbols on, a kind the graph gained shows");
});
