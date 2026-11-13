import { test } from "node:test";
import assert from "node:assert/strict";
import { cycleCount, cycleGroups, GRAPH_FILE_LIMIT, GRAPH_READ_MAX, graphShape, runCodeGraph, validateGraphDoc } from "../native/codegraph.ts";

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
  files[G] = JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }); // a fixture: a valid, empty graph-kit document
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

const valid = { schemaVersion: 1, nodes: [{ id: "file:a.py", kind: "file" }, { id: "file:b.py", kind: "file" }], edges: [{ fromId: "file:a.py", toId: "file:b.py", kind: "imports" }] };

test("validateGraphDoc accepts a valid graph-kit document", () => {
  assert.equal(validateGraphDoc(valid), null);
});

test("validateGraphDoc names the first problem in a graph-kit document", () => {
  assert.equal(validateGraphDoc({ ...valid, schemaVersion: undefined }), "the graph has no numeric schemaVersion");
  assert.equal(validateGraphDoc({ ...valid, schemaVersion: "1" }), "the graph has no numeric schemaVersion");
  assert.equal(validateGraphDoc({ ...valid, nodes: [...valid.nodes, { id: "file:a.py", kind: "file" }] }), "2 nodes share the id file:a.py");
  assert.equal(validateGraphDoc({ ...valid, nodes: [{ kind: "file" }] }), "node 1 has no id");
  assert.equal(validateGraphDoc({ ...valid, nodes: [{ id: "file:a.py" }] }), "node 1 (file:a.py) has no kind");
  assert.equal(
    validateGraphDoc({ ...valid, edges: [...valid.edges, { fromId: "file:a.py", toId: "file:gone.py", kind: "imports" }] }),
    "1 edges point at a node that does not exist, for example file:a.py -> file:gone.py",
  );
  assert.equal(validateGraphDoc({ ...valid, edges: [{ fromId: "file:a.py", toId: "file:b.py" }] }), "edge 1 has no kind");
  assert.equal(validateGraphDoc({ ...valid, edges: undefined }), "the graph has no edges list");
});

test("validateGraphDoc checks only that the old Mac shape has list fields", () => {
  assert.equal(validateGraphDoc({ files: [], calls: [] }), null);
  assert.equal(validateGraphDoc({ files: [{ path: "a" }], calls: [{ from: "x" }] }), null);
  assert.equal(validateGraphDoc({ files: "nope", calls: [] }), "the graph's files is not a list");
  assert.equal(validateGraphDoc({ files: [], calls: {} }), "the graph's calls is not a list");
  assert.equal(validateGraphDoc({ calls: {} }), "the graph file is not a graph document");
});

test("validateGraphDoc rejects anything that is neither shape", () => {
  for (const doc of [null, "text", 3, [], {}, { nodes: "x" }, { schemaVersion: 1 }]) {
    assert.equal(validateGraphDoc(doc), "the graph file is not a graph document", JSON.stringify(doc));
  }
});

test("snapshot of an invalid graph fails and writes no baseline", async () => {
  const files = { [G]: JSON.stringify({ ...valid, edges: [{ fromId: "file:a.py", toId: "file:gone.py", kind: "imports" }] }) };
  const fs = mem(files);
  const r = await runCodeGraph(fs, "snapshot", G, B);
  assert.equal(r.passed, false);
  assert.match(r.output, /^graph invalid: 1 edges point at a node that does not exist/);
  assert.equal(B in files, false);
});

test("a truncated graph file is an invalid graph, not a baseline", async () => {
  const files = { [G]: JSON.stringify(valid).slice(0, 40) };
  const fs = mem(files);
  const r = await runCodeGraph(fs, "snapshot", G, B);
  assert.equal(r.passed, false);
  assert.equal(r.output, "graph invalid: the graph file is not valid JSON");
  assert.equal(B in files, false);
});

test("snapshot of an empty graph-kit document fails with the nothing-to-refactor message", async () => {
  const files = { [G]: JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }) };
  const fs = mem(files);
  const r = await runCodeGraph(fs, "snapshot", G, B);
  assert.deepEqual(r, { passed: false, output: "the scan found no code, so there is nothing to refactor" });
  assert.equal(B in files, false);
});

test("verify with a corrupt baseline fails with the baseline message", async () => {
  const files = { [G]: kit(["a.py"], []), [B]: JSON.stringify({ schemaVersion: 1, nodes: [{ id: "file:a.py", kind: "file" }], edges: [{ fromId: "file:a.py", toId: "file:x.py", kind: "imports" }] }) };
  const r = await runCodeGraph(mem(files), "verify", G, B);
  assert.equal(r.passed, false);
  assert.match(r.output, /^the baseline snapshot is invalid: 1 edges point at a node that does not exist, for example file:a.py -> file:x.py; run the snapshot stage again$/);
});

test("verify with a truncated baseline fails with the baseline message", async () => {
  const files = { [G]: kit(["a.py"], []), [B]: kit(["a.py"], []).slice(0, 30) };
  const r = await runCodeGraph(mem(files), "verify", G, B);
  assert.equal(r.output, "the baseline snapshot is invalid: the graph file is not valid JSON; run the snapshot stage again");
});

test("a rescan is awaited before the graph is read, and only read, write and create are used", async () => {
  let rescanned = false;
  const calls = [];
  const files = { [G]: kit(["a.py"], []) };
  const fs = {
    async read(path) { calls.push("read"); assert.equal(rescanned, true, "read before the rescan finished"); return { status: "ok", text: files[path] }; },
    async write(path, text) { calls.push("write"); files[path] = text; },
    async create() { calls.push("create"); },
  };
  const r = await runCodeGraph(fs, "snapshot", G, B, async () => { await new Promise((res) => setTimeout(res, 5)); rescanned = true; });
  assert.equal(r.passed, true, r.output);
  assert.equal(rescanned, true);
  assert.ok(calls.every((c) => ["read", "write", "create"].includes(c)));
});

test("a graph over the 32 MB read cap fails with the size and the Input path advice, and is read with that cap", async () => {
  const seen = [];
  const fs = { async read(path, max) { seen.push(max); return { status: "too_large", size: 29 * 1024 * 1024, text: null }; }, async write() {}, async create() {} };
  const r = await runCodeGraph(fs, "snapshot", G, B);
  assert.equal(r.passed, false);
  assert.equal(r.output, "the code graph is 29 MB, over the 32 MB the app can read; set the loop's Input path to a folder to scan less");
  assert.deepEqual(seen, [GRAPH_READ_MAX]);
  const noSize = await runCodeGraph({ async read() { return { status: "too_large", text: null }; }, async write() {}, async create() {} }, "verify", G, B);
  assert.equal(noSize.output, "the code graph is over the 32 MB the app can read; set the loop's Input path to a folder to scan less");
});

test("a snapshot at graph-kit's file limit passes with a warning; one file under it has none", async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => `f${i}.py`);
  const at = await runCodeGraph(mem({ [G]: kit(many(GRAPH_FILE_LIMIT), []) }), "snapshot", G, B);
  assert.equal(at.passed, true);
  assert.match(at.output, /\nwarning: the scan reached graph-kit's 20000-file limit; files beyond it are not in the graph$/);
  const under = await runCodeGraph(mem({ [G]: kit(many(GRAPH_FILE_LIMIT - 1), []) }), "snapshot", G, B);
  assert.equal(under.passed, true);
  assert.doesNotMatch(under.output, /warning/);
});

test("the snapshot result carries the validated document for the digest", async () => {
  const r = await runCodeGraph(mem({ [G]: kit(["a.py"], []) }), "snapshot", G, B);
  assert.equal(r.graph.nodes[0].id, "file:a.py");
});

test("cycleGroups returns each cycle's files", async () => {
  assert.deepEqual(cycleGroups([{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "c", to: "c" }]).map((g) => g.sort()), [["a", "b"], ["c"]]);
});
