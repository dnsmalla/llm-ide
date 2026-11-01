import { test } from "node:test";
import assert from "node:assert/strict";
import { runCodeGraph } from "../native/codegraph.ts";

function mem(files) {
  return {
    async read(path) { if (!(path in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[path] }; },
    async write(path, text) { files[path] = text; },
    async create() {},
  };
}

test("code graph snapshot and verify detect a shrunken graph", async () => {
  const files = { "system/graph/graph.json": JSON.stringify({ nodes: [1, 2], edges: [1], files: [1] }) };
  const fs = mem(files);
  const snap = await runCodeGraph(fs, "snapshot", "system/graph/graph.json", "system/loop/refactor/graph/before.json");
  assert.equal(snap.passed, true);
  assert.ok(files["system/loop/refactor/graph/before.json"]);
  const stable = await runCodeGraph(fs, "verify", "system/graph/graph.json", "system/loop/refactor/graph/before.json");
  assert.equal(stable.passed, true);
  files["system/graph/graph.json"] = JSON.stringify({ nodes: [1], edges: [1], files: [1] });
  const shrunk = await runCodeGraph(fs, "verify", "system/graph/graph.json", "system/loop/refactor/graph/before.json");
  assert.equal(shrunk.passed, false);
  assert.match(shrunk.output, /shrank/);
});
