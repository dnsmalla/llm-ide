import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleCount, graphShape, runCodeGraph } from "../native/codegraph.ts";

function mem(files) {
  return {
    async read(path) { if (!(path in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[path] }; },
    async write(path, text) { files[path] = text; },
    async create() {},
  };
}

const G = "system/graph/graph-code.json";
const B = "system/loop/refactor/graph/before.json";
const kit = (files, imports, extra = 0) => JSON.stringify({
  schemaVersion: 1,
  nodes: [...files.map((f) => ({ id: `file:${f}`, kind: "file" })), ...Array.from({ length: extra }, (_, i) => ({ id: `symbol:x#${i}`, kind: "function" }))],
  edges: imports.map(([a, b]) => ({ fromId: `file:${a}`, toId: `file:${b}`, kind: "imports" })),
});

test("snapshot saves the graph; verify passes a refactor that shrinks it and reports the change", async () => {
  const files = { [G]: kit(["shop.py", "utils.py", "legacy.py"], [["shop.py", "utils.py"]], 5) };
  const fs = mem(files);
  const snap = await runCodeGraph(fs, "snapshot", G, B);
  assert.equal(snap.passed, true);
  assert.equal(files[B], files[G]);
  assert.match(snap.output, /3 file\(s\)/, "files are counted from graph-kit file nodes");
  files[G] = kit(["shop.py", "utils.py"], [["shop.py", "utils.py"]], 3); // legacy.py deleted, duplicates merged
  const r = await runCodeGraph(fs, "verify", G, B);
  assert.equal(r.passed, true, r.output);
  assert.match(r.output, /2 file\(s\) \(-1\), 5 node\(s\) \(-3\)/);
});

test("verify fails a new import cycle in graph-kit's file imports, and an empty graph", async () => {
  const files = { [G]: kit(["a.py", "b.py"], [["a.py", "b.py"]]) };
  const fs = mem(files);
  await runCodeGraph(fs, "snapshot", G, B);
  files[G] = kit(["a.py", "b.py"], [["a.py", "b.py"], ["b.py", "a.py"]]);
  const cyc = await runCodeGraph(fs, "verify", G, B);
  assert.equal(cyc.passed, false);
  assert.match(cyc.output, /cycles 0 → 1/);
  files[G] = JSON.stringify({ nodes: [], edges: [] });
  assert.match((await runCodeGraph(fs, "verify", G, B)).output, /came back empty/);
});

test("a cycle that the refactor removes is an improvement, and a module node is never a file cycle", async () => {
  const files = { [G]: kit(["a.py", "b.py"], [["a.py", "b.py"], ["b.py", "a.py"]]) };
  const fs = mem(files);
  assert.match((await runCodeGraph(fs, "snapshot", G, B)).output, /1 cycle\(s\)/);
  files[G] = kit(["a.py", "b.py"], [["a.py", "b.py"]]);
  const r = await runCodeGraph(fs, "verify", G, B);
  assert.equal(r.passed, true);
  assert.match(r.output, /0 cycle\(s\) \(-1\)/);
  assert.equal(graphShape({ nodes: [{ id: "file:a.py", kind: "file" }, { id: "module:a", kind: "other" }], edges: [{ fromId: "file:a.py", toId: "module:a", kind: "imports" }, { fromId: "module:a", toId: "file:a.py", kind: "imports" }] }).cycles, 0);
});

test("the old Mac shape still counts files over 500 lines", async () => {
  const files = { [G]: JSON.stringify({ files: [{ path: "a", loc: 100, functions: [] }], calls: [] }) };
  const fs = mem(files);
  await runCodeGraph(fs, "snapshot", G, B);
  files[G] = JSON.stringify({ files: [{ path: "a", loc: 700, functions: [] }], calls: [] });
  assert.match((await runCodeGraph(fs, "verify", G, B)).output, /files over 500 lines 0 → 1/);
});

test("code graph reads the canonical GraphKit files/calls shape", async () => {
  const files = { "system/graph/graph.json": JSON.stringify({ files: [{ functions: [{ name: "a" }, { name: "b" }] }], calls: [{ from: "x", to: "y" }] }) };
  const r = await runCodeGraph(mem(files), "snapshot", "system/graph/graph.json", "system/loop/refactor/graph/before.json");
  assert.equal(r.passed, true);
  assert.match(r.output, /2 node\(s\)/);
  assert.match(r.output, /1 edge\(s\)/);
});

test("cycleCount counts SCCs and self-loops", async () => {
  assert.equal(cycleCount([{ from: "a", to: "b" }, { from: "b", to: "a" }]), 1);
  assert.equal(cycleCount([{ from: "a", to: "a" }]), 1);
  assert.equal(cycleCount([{ from: "a", to: "b" }, { from: "b", to: "c" }]), 0);
});

test("F1: a later run replaces the old baseline in the main tree instead of failing", async () => {
  const files = { [G]: kit(["a.py"], []) };
  const store = {
    ...mem(files),
    async read(path) { if (!(path in files)) throw Object.assign(new Error("not found"), { code: "not_found" }); return { status: "ok", text: files[path] }; },
    async write(path, text, opts) { if (path in files && !opts.force) throw Object.assign(new Error("the file already exists"), { code: "exists" }); files[path] = text; },
  };
  assert.equal((await runCodeGraph(store, "snapshot", G, B)).passed, true);
  files[G] = kit(["a.py", "b.py"], []);
  assert.equal((await runCodeGraph(store, "snapshot", G, B)).passed, true);
  assert.equal(files[B], files[G]);
});
