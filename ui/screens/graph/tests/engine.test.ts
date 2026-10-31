import { test } from "node:test";
import assert from "node:assert/strict";
import { LayoutEngine } from "../engine.ts";
import { LayoutCache, sha256Hex, estimateBytes, type CacheEntry } from "../cache.ts";
import type { FromWorker, ToWorker, WorkerLike } from "../protocol.ts";
import { decodeGraph } from "../decode.ts";
import { runJob } from "../layout-job.ts";
import { loadWasmBytes } from "./wasm-helper.ts";

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike["onmessage"] = null;
  onerror: WorkerLike["onerror"] = null;
  onmessageerror: WorkerLike["onmessageerror"] = null;
  sent: ToWorker[] = [];
  terminated = false;
  postMessage(m: ToWorker) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  emit(m: unknown) { this.onmessage?.({ data: m as FromWorker }); }
}

async function entry(): Promise<CacheEntry> {
  const r = await runJob(JSON.stringify({ files: [{ path: "a.ts", imports: ["b.ts"] }, { path: "b.ts" }] }), { loadWasm: loadWasmBytes });
  return { model: r.model, layout: r.layout, notices: r.notices };
}
const mk = (workers: FakeWorker[], extra = {}) => new LayoutEngine({ wasmUrl: "x.wasm", createWorker: () => { const w = new FakeWorker(); workers.push(w); return w; }, hash: async (t) => `h:${t}`, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a job runs in a worker, reports stages, caches by hash and terminates the worker", async () => {
  const ws: FakeWorker[] = [];
  const eng = mk(ws);
  const stages: string[] = [];
  const p = eng.load("T", (s) => stages.push(s));
  await tick();
  assert.equal(ws.length, 1);
  const j = ws[0].sent[0].job;
  assert.deepEqual(ws[0].sent[0], { type: "run", job: j, text: "T", wasmUrl: "x.wasm" });
  ws[0].emit({ type: "progress", job: j, stage: "decode" });
  ws[0].emit({ type: "progress", job: j, stage: "layout" });
  const e = await entry();
  ws[0].emit({ type: "done", job: j, model: e.model, layout: e.layout, notices: ["n"] });
  const out = await p;
  assert.equal(out.kind, "done");
  assert.equal(out.kind === "done" && out.cached, false);
  assert.deepEqual(stages, ["hash", "decode", "layout"]);
  assert.equal(ws[0].terminated, true);
  // second load of the same text: cache hit, no new worker
  const again = await eng.load("T");
  assert.equal(again.kind === "done" && again.cached, true);
  assert.equal(ws.length, 1);
});

test("cancel mid-layout terminates the worker and resolves 'cancelled'", async () => {
  const ws: FakeWorker[] = [];
  const eng = mk(ws);
  const p = eng.load("T");
  await tick();
  assert.equal(eng.busy, true);
  eng.cancel();
  assert.equal((await p).kind, "cancelled");
  assert.equal(ws[0].terminated, true);
  assert.equal(eng.busy, false);
  eng.cancel(); // idempotent
});

test("a new load cancels the running one; late messages from the old job are ignored", async () => {
  const ws: FakeWorker[] = [];
  const eng = mk(ws);
  const first = eng.load("A");
  await tick();
  const second = eng.load("B");
  assert.equal((await first).kind, "cancelled");
  await tick();
  assert.equal(ws.length, 2);
  const e = await entry();
  const j = ws[1].sent[0].job;
  ws[0].emit({ type: "done", job: j, model: e.model, layout: e.layout, notices: [] }); // handler was detached: no effect
  ws[1].emit({ type: "done", job: j - 1, model: e.model, layout: e.layout, notices: [] }); // wrong job id
  ws[1].emit({ type: "done", job: j, model: e.model, layout: e.layout, notices: [] });
  assert.equal((await second).kind, "done");
});

test("worker error, onerror, garbage messages and a hung worker are all contained", async () => {
  let ws: FakeWorker[] = [];
  let eng = mk(ws);
  let p = eng.load("T");
  await tick();
  ws[0].emit("garbage");
  ws[0].emit(null);
  ws[0].emit({ type: "done" }); // no job id
  ws[0].emit({ type: "error", job: ws[0].sent[0].job, message: "Graph document needs nodes" });
  let out = await p;
  assert.deepEqual(out, { kind: "error", message: "Graph document needs nodes" });

  ws = []; eng = mk(ws);
  p = eng.load("T"); await tick();
  ws[0].onerror?.({ message: "boom" });
  out = await p;
  assert.deepEqual(out, { kind: "error", message: "boom" });
  assert.equal(ws[0].terminated, true);

  // watchdog: the injected timer fires
  ws = []; let fire: (() => void) | null = null;
  eng = mk(ws, { setTimer: (fn: () => void) => { fire = fn; return 1; }, clearTimer: () => {} });
  p = eng.load("T"); await tick();
  assert.ok(fire);
  (fire as () => void)();
  out = await p;
  assert.equal(out.kind === "error" && /too long/.test(out.message), true);
  assert.equal(ws[0].terminated, true);
});

test("postMessage throwing (for example a clone failure) becomes an error outcome", async () => {
  const ws: FakeWorker[] = [];
  const eng = new LayoutEngine({ wasmUrl: "x", hash: async () => "h", createWorker: () => { const w = new FakeWorker(); w.postMessage = () => { throw new Error("DataCloneError"); }; ws.push(w); return w; } });
  const out = await eng.load("T");
  assert.deepEqual(out, { kind: "error", message: "DataCloneError" });
});

test("cancel during hashing never starts a worker", async () => {
  const ws: FakeWorker[] = [];
  let release!: (v: string) => void;
  const eng = new LayoutEngine({ wasmUrl: "x", createWorker: () => { const w = new FakeWorker(); ws.push(w); return w; }, hash: () => new Promise<string>((r) => { release = r; }) });
  const p = eng.load("T");
  eng.cancel();
  release("h");
  assert.equal((await p).kind, "cancelled");
  assert.equal(ws.length, 0);
});

test("cache: LRU by entries and by bytes, key includes the layout version, real sha256", async () => {
  const e = await entry();
  const c = new LayoutCache(estimateBytes(e) * 2 + 10, 5);
  c.set("a", e); c.set("b", e);
  assert.equal(c.size, 2);
  assert.ok(c.get("a")); // a is now most recent
  c.set("c", e);
  assert.equal(c.get("b"), undefined, "least recently used evicted by the byte budget");
  assert.ok(c.get("a") && c.get("c"));
  const tiny = new LayoutCache(1, 5);
  tiny.set("x", e);
  assert.equal(tiny.size, 0, "an entry bigger than the whole budget is not kept");
  const byCount = new LayoutCache(1e9, 1);
  byCount.set("a", e); byCount.set("b", e);
  assert.equal(byCount.size, 1);
  assert.match(LayoutCache.key("abc"), /^k\d+:abc$/);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  c.clear();
  assert.equal(c.retainedBytes, 0);
});

test("an end-to-end worker substitute: the real job function behind the fake worker", async () => {
  const ws: FakeWorker[] = [];
  const eng = new LayoutEngine({ wasmUrl: "x", hash: sha256Hex, createWorker: () => { const w = new FakeWorker(); ws.push(w); w.postMessage = (m) => { void runJob(m.text, { loadWasm: loadWasmBytes }).then((r) => w.emit({ type: "done", job: m.job, model: r.model, layout: r.layout, notices: r.notices })); }; return w; } });
  const out = await eng.load(JSON.stringify({ files: [{ path: "a.ts", imports: ["b.ts"] }, { path: "b.ts" }] }));
  assert.equal(out.kind, "done");
  assert.equal(out.kind === "done" && out.entry.model.n, 2);
  assert.equal(decodeGraph("{\"files\":[]}").n, 0);
});

test("preview first, then done without a model: the engine joins them and caches the final layout", async () => {
  const ws: FakeWorker[] = [];
  const eng = mk(ws);
  const previews: unknown[] = [];
  const p = eng.load("T", undefined, (pv) => previews.push(pv));
  await tick();
  const j = ws[0].sent[0].job;
  const e = await entry();
  ws[0].emit({ type: "preview", job: j, model: e.model, layout: { ...e.layout, engine: "fallback" }, notices: [] });
  assert.equal(previews.length, 1);
  assert.equal(eng.busy, true, "still working on the full layout");
  ws[0].emit({ type: "done", job: j, layout: e.layout, notices: ["final"] });
  const out = await p;
  assert.equal(out.kind === "done" && out.entry.model, e.model);
  assert.equal(out.kind === "done" && out.entry.layout.engine, "wasm");
  assert.equal((await eng.load("T")).kind === "done" && true, true);
  assert.equal(ws.length, 1, "second load came from the cache");
});

test("done without a model and without a preview is an error, not a crash", async () => {
  const ws: FakeWorker[] = [];
  const eng = mk(ws);
  const p = eng.load("T");
  await tick();
  const e = await entry();
  ws[0].emit({ type: "done", job: ws[0].sent[0].job, layout: e.layout, notices: [] });
  const out = await p;
  assert.equal(out.kind === "error" && /no graph/.test(out.message), true);
});
