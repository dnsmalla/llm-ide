import { test } from "node:test";
import assert from "node:assert/strict";
import { runJob } from "../layout-job.ts";
import { fallbackLayout } from "../fallback-layout.ts";
import { decodeGraph, GraphDecodeError } from "../decode.ts";
import { synthKitGraph } from "../bench/synth.ts";
import { transferables } from "../protocol.ts";
import { loadWasmBytes } from "./wasm-helper.ts";

test("runJob: decode, kernel layout, ranks, one pass", async () => {
  const stages: string[] = [];
  const r = await runJob(synthKitGraph({ nodes: 500 }), { loadWasm: loadWasmBytes, progress: (s) => stages.push(s) });
  assert.deepEqual(stages, ["decode", "layout"]);
  assert.equal(r.layout.engine, "wasm");
  assert.equal(r.layout.n, r.model.n);
  assert.equal(r.layout.pos.length, 2 * r.model.n);
  assert.equal(r.layout.rank.length, r.model.n);
  assert.ok(r.layout.ms >= 0);
  const bufs = transferables(r.model, r.layout);
  assert.ok(bufs.length >= 10 && bufs.every((b) => b instanceof ArrayBuffer));
});

test("runJob falls back (with a notice) when the wasm cannot be loaded", async () => {
  const r = await runJob(synthKitGraph({ nodes: 300 }), { loadWasm: async () => { throw new Error("blocked by policy"); } });
  assert.equal(r.layout.engine, "fallback");
  assert.ok(r.notices.some((n) => /blocked by policy/.test(n) && /fallback/.test(n)));
  for (const v of r.layout.pos) assert.ok(Number.isFinite(v));
});

test("runJob falls back when the module is corrupt", async () => {
  const r = await runJob(synthKitGraph({ nodes: 50 }), { loadWasm: async () => new Uint8Array([1, 2, 3]) });
  assert.equal(r.layout.engine, "fallback");
});

test("runJob: malformed text rejects with a safe message; an empty graph skips layout", async () => {
  await assert.rejects(() => runJob("nope", { loadWasm: loadWasmBytes }), GraphDecodeError);
  const r = await runJob(JSON.stringify({ files: [] }), { loadWasm: async () => { throw new Error("must not be called"); } });
  assert.equal(r.model.n, 0);
  assert.equal(r.layout.engine, "wasm");
});

test("fallback layout: deterministic, finite, one community per planted cluster at least roughly", () => {
  const model = decodeGraph(synthKitGraph({ nodes: 1200, clusterSize: 60 }));
  const a = fallbackLayout(model);
  const b = fallbackLayout(model);
  assert.deepEqual(Array.from(a.pos), Array.from(b.pos));
  for (const v of a.pos) assert.ok(Number.isFinite(v));
  assert.ok(a.communityCount >= 5 && a.communityCount < 600, `communities ${a.communityCount}`);
  assert.equal(a.degree.length, model.n);
});

test("fallback layout handles 50k nodes inside a generous budget", () => {
  const model = decodeGraph(synthKitGraph({ nodes: 50_000 }));
  const t = performance.now();
  const out = fallbackLayout(model);
  assert.equal(out.n, 50_000);
  assert.ok(performance.now() - t < 20_000, "fallback must never take minutes");
});

test("big graphs send a fast preview before the kernel result; small ones do not", async () => {
  const events: string[] = [];
  const big = await runJob(synthKitGraph({ nodes: 5200 }), {
    loadWasm: async () => { events.push("wasm"); return loadWasmBytes(); },
    onPreview: (m, l, n) => { events.push(`preview:${l.engine}:${m.n}`); assert.ok(Array.isArray(n)); },
  });
  assert.deepEqual(events, ["preview:fallback:5200", "wasm"], "the preview is delivered before the kernel starts");
  assert.equal(big.layout.engine, "wasm");
  const small: string[] = [];
  await runJob(synthKitGraph({ nodes: 200 }), { loadWasm: loadWasmBytes, onPreview: () => small.push("p") });
  assert.deepEqual(small, []);
});

test("a kernel failure after a preview still ends with a (fallback) final layout", async () => {
  const r = await runJob(synthKitGraph({ nodes: 5200 }), { loadWasm: async () => { throw new Error("no wasm"); }, onPreview: () => {} });
  assert.equal(r.layout.engine, "fallback");
});
