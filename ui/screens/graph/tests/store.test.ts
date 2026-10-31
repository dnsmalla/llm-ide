import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphStore, type StoreDeps } from "../store.ts";
import { classifyReadError, customGraphPath, joinRoot, readProjectGraph, GRAPH_CANDIDATES } from "../source.ts";
import type { JobOutcome } from "../engine.ts";
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

test("store.cancel during loading returns to idle without an entry", async () => {
  let release!: (v: string) => void;
  const st = new GraphStore({ engine: deps({}).engine, invoke: () => new Promise<string>((r) => { release = r; }) });
  const p = st.load("/p");
  st.cancel();
  release(GOOD);
  await p;
  assert.equal(st.getSnapshot().phase, "idle");
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
