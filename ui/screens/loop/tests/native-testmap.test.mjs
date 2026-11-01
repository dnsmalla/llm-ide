import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/testmap.ts";
const { detectTestStructure } = m;

function mem(files) {
  return {
    async read(p) { if (!(p in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[p] }; },
    async list(dir) {
      const prefix = dir === "." ? "" : `${dir}/`;
      const names = new Map();
      for (const p of Object.keys(files)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length); const seg = rest.split("/")[0];
        names.set(seg, rest.includes("/") ? "dir" : "file");
      }
      if (names.size === 0 && dir !== ".") throw Object.assign(new Error("missing"), { code: "missing" });
      return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) };
    },
    async create() {}, async write() {},
  };
}

test("test structure detects a Swift package and a Node package", async () => {
  const fs = mem({
    "Package.swift": 'let package = Package(name: "X", targets: [.testTarget(name: "XTests")])',
    "Tests/XTests/a.swift": "",
    "web/package.json": '{"scripts":{"test":"vitest"}}',
    "web/tests/a.test.ts": "",
  });
  const s = await detectTestStructure(fs, "", new Date("2026-01-01T00:00:00Z"));
  assert.equal(s.status, "ok");
  assert.deepEqual(s.roots.map((r) => r.runner).sort(), ["npm", "xctest"]);
  assert.equal(s.roots.find((r) => r.runner === "npm").command, "cd web && npm test");
});

test("missing test roots are reported, not invented", async () => {
  const s = await detectTestStructure(mem({ "README.md": "" }), "", new Date("2026-01-01T00:00:00Z"));
  assert.equal(s.status, "missing");
  assert.equal(s.roots.length, 0);
});

test("test map uses graph function nodes and test tokens", async () => {
  const files = {
    "Package.swift": 'x .testTarget(name: "XTests")',
    "Tests/XTests/a.swift": 'func testFoo() { add(1,2) }',
    "src/math.swift": "func add() {}",
    "system/graph/graph.json": JSON.stringify({ nodes: [{ kind: "function", title: "add", metadata: { path: "src/math.swift", line: 1 } }] }),
  };
  const fs = {
    async read(p) { if (!(p in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[p] }; },
    async list(dir) { const prefix = dir === "." ? "" : `${dir}/`; const names = new Map(); for (const p of Object.keys(files)) { if (!p.startsWith(prefix)) continue; const rest = p.slice(prefix.length); const seg = rest.split("/")[0]; names.set(seg, rest.includes("/") ? "dir" : "file"); } if (!names.size && dir !== ".") throw Object.assign(new Error("missing"), { code: "missing" }); return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) }; },
    async create() {}, async write() {},
  };
  const structure = await m.detectTestStructure(fs, "", new Date("2026-01-01T00:00:00Z"));
  const map = await m.buildTestMap(fs, "", structure, "system/graph/graph.json", new Date("2026-01-01T00:00:00Z"));
  assert.equal(map.source, "graph");
  assert.equal(map.testedFunctions, 1);
  assert.equal(map.entries[0].function, "add");
});

test("ledger parses XCTest lines and diffs against the previous run", async () => {
  const out = "Test Case '-[MathTests testAdd]' passed (0.01 seconds).\nTest Case '-[MathTests testSub]' failed (0.02 seconds).";
  const parsed = m.parseTestResults(out);
  assert.deepEqual(parsed.passing, ["MathTests testAdd"]);
  assert.deepEqual(parsed.failing, ["MathTests testSub"]);
  const diff = m.ledgerDiff({ runId: "old", recordedAt: "", failing: ["MathTests testSub", "MathTests testOld"], passing: [] }, parsed, true);
  assert.deepEqual(diff.newFailures, []);
  assert.deepEqual(diff.stillFailing, ["MathTests testSub"]);
  assert.deepEqual(diff.fixed, ["MathTests testOld"]);
});
