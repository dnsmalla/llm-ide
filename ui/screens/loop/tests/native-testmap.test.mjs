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

test("test map reads canonical GraphKit files/functions", async () => {
  const files = {
    "tests/a.test.ts": "test('adds', () => { expect(add(1,2)).toBe(3) })",
    "src/math.ts": "export function add() {}",
    "system/graph/graph.json": JSON.stringify({ files: [{ path: "src/math.ts", name: "math.ts", loc: 3, usedBy: ["x"], imports: [], functions: [{ name: "add", line: 1 }] }], calls: [] }),
  };
  const fs = { async read(p) { if (!(p in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[p] }; }, async list(dir) { const prefix = dir === "." ? "" : `${dir}/`; const names = new Map(); for (const p of Object.keys(files)) { if (!p.startsWith(prefix)) continue; const rest = p.slice(prefix.length); const seg = rest.split("/")[0]; names.set(seg, rest.includes("/") ? "dir" : "file"); } if (!names.size && dir !== ".") throw Object.assign(new Error("missing"), { code: "missing" }); return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) }; }, async create() {}, async write() {} };
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "npm", command: "npm test", languages: ["ts"] }] };
  const map = await m.buildTestMap(fs, "", structure, "system/graph/graph.json", new Date("2026-01-01T00:00:00Z"));
  assert.equal(map.source, "graph");
  assert.equal(map.testedFunctions, 1);
  assert.equal(map.entries[0].fanIn, 1);
});

/** A fake fs with the host's write and read rules: create-only unless `force`, a too-large read is a status, a missing read throws. */
function hostFs(files = {}) {
  return {
    files,
    async read(path, maxBytes) {
      if (!(path in files)) throw Object.assign(new Error(`not found: ${path}`), { code: "not_found" });
      if (Buffer.byteLength(files[path]) > maxBytes) return { status: "too_large", text: null };
      return { status: "ok", text: files[path], hash: "h" };
    },
    async write(path, text, opts) {
      if (path in files && !opts.force) throw Object.assign(new Error("the file already exists"), { code: "exists" });
      files[path] = text;
      return { path, size: text.length, mtime_ms: 0, hash: "h" };
    },
    async create() {},
    async list() { return { entries: [] }; },
  };
}

test("F1: regenerated TEST-STRUCTURE, TEST-MAP and ledger overwrite the previous run's files", async () => {
  const fs = hostFs();
  const structure = { generatedAt: "", status: "missing", notes: [], roots: [] };
  await m.writeTestStructure(fs, "", structure);
  await m.writeTestStructure(fs, "", { ...structure, notes: ["second"] });
  assert.match(fs.files["system/loop/test/TEST-STRUCTURE.json"], /second/);
  const map = { generatedAt: "", source: "files", entries: [], untestedFunctions: 0, testedFunctions: 0, untestedFiles: 0 };
  await m.writeTestMap(fs, "", map);
  await m.writeTestMap(fs, "", { ...map, untestedFiles: 2 });
  assert.match(fs.files["system/loop/test/TEST-MAP.json"], /"untestedFiles": 2/);
  await m.writeLedger(fs, "system/loop/test/ledger.json", { runId: "a", recordedAt: "", failing: [], passing: [] });
  await m.writeLedger(fs, "system/loop/test/ledger.json", { runId: "b", recordedAt: "", failing: ["x"], passing: [] });
  assert.match(fs.files["system/loop/test/ledger.json"], /"runId": "b"/);
});

test("F8: pytest -rA and -v lines and node:test spec lines are parsed", () => {
  const rA = "PASSED tests/a.py::test_add\nFAILED tests/a.py::test_sub - assert 1 == 2\nFAILED tests/a.py::test_div[0] [ 50%]\n";
  const parsedA = m.parseTestResults(rA);
  assert.deepEqual(parsedA.passing, ["tests/a.py::test_add"]);
  assert.deepEqual(parsedA.failing, ["tests/a.py::test_div[0]", "tests/a.py::test_sub"]);
  const verbose = "tests/b.py::test_one PASSED                    [ 33%]\ntests/b.py::test_two FAILED                    [ 66%]\n";
  const parsedV = m.parseTestResults(verbose);
  assert.deepEqual(parsedV.passing, ["tests/b.py::test_one"]);
  assert.deepEqual(parsedV.failing, ["tests/b.py::test_two"]);
  const spec = "✔ adds numbers (1.2ms)\n✖ subtracts numbers (0.4ms)\n✖ divides (3ms)\n";
  const parsedS = m.parseTestResults(spec);
  assert.deepEqual(parsedS.passing, ["adds numbers"]);
  assert.deepEqual(parsedS.failing, ["divides", "subtracts numbers"]);
  assert.deepEqual(m.parseTestResults("no results here\n"), { failing: [], passing: [] });
});

test("R4: pytest ERROR lines and jest ● failure headers count as failing, not passing", () => {
  const shortSummary = "ERROR tests/a.py::test_setup - fixture 'db' not found\nFAILED tests/a.py::test_sub - assert 1 == 2\n";
  assert.deepEqual(m.parseTestResults(shortSummary), { failing: ["tests/a.py::test_setup", "tests/a.py::test_sub"], passing: [] });
  const verbose = "tests/b.py::test_one PASSED                    [ 33%]\ntests/b.py::test_two ERROR                   [ 66%]\n";
  assert.deepEqual(m.parseTestResults(verbose), { failing: ["tests/b.py::test_two"], passing: ["tests/b.py::test_one"] });
  const jest = "  ✓ adds numbers (2 ms)\n  ● math › divides by zero\n";
  assert.deepEqual(m.parseTestResults(jest), { failing: ["math › divides by zero"], passing: ["adds numbers"] });
});

test("F9: pytest default progress lines record one result per file, with per-test names winning", () => {
  const out = [
    "============================= test session starts ==============================",
    "collected 3 items",
    "",
    "tests/test_golden.py ..                                                  [ 66%]",
    "tests/test_tax.py F                                                      [100%]",
    "=================================== FAILURES ===================================",
    "=========================== short test summary info ============================",
    "FAILED tests/test_tax.py::test_jp_tax_is_ten_percent - assert 0.12 == 0.1",
    "========================= 1 failed, 2 passed in 0.03s ==========================",
  ].join("\n");
  const parsed = m.parseTestResults(out);
  assert.ok(parsed.failing.includes("tests/test_tax.py::test_jp_tax_is_ten_percent"));
  assert.ok(parsed.passing.includes("tests/test_golden.py"));
  assert.ok(!parsed.passing.includes("tests/test_tax.py"));
  assert.ok(!parsed.failing.includes("tests/test_tax.py"));
});

test("F9: an all-pass progress line records the file as passing", () => {
  assert.deepEqual(m.parseTestResults("tests/test_golden.py ..  [100%]\n"), { failing: [], passing: ["tests/test_golden.py"] });
});

test("F9: a file with only skip marks records nothing", () => {
  assert.deepEqual(m.parseTestResults("tests/test_skip.py ssx  [100%]\n"), { failing: [], passing: [] });
});

test("F9: pytest -q output (bare dots, no file) records only the summary's named failures", () => {
  const out = "..F.                                                                 [100%]\nFAILED tests/test_tax.py::test_rate - assert 1 == 2\n1 failed, 3 passed in 0.02s\n";
  assert.deepEqual(m.parseTestResults(out), { failing: ["tests/test_tax.py::test_rate"], passing: [] });
  assert.deepEqual(m.parseTestResults("...F  [100%]\n"), { failing: [], passing: [] });
});

test("without a usable graph, the map lists source files; a file no test names is untested, test files are not entries", async () => {
  const fs = mem({
    "a.py": "def f(): pass",
    "b.py": "def g(): pass",
    "system/x.py": "",
    "tests/test_a.py": "import a\n\ndef test_f():\n    a.f()\n",
  });
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "pytest", command: "pytest", languages: ["py"] }] };
  const map = await m.buildTestMap(fs, "", structure, "system/graph/graph-code.json", new Date("2026-01-01T00:00:00Z"));
  assert.equal(map.source, "files");
  assert.deepEqual(map.entries.map((e) => e.path).sort(), ["a.py", "b.py"]);
  const a = map.entries.find((e) => e.path === "a.py");
  const b = map.entries.find((e) => e.path === "b.py");
  assert.equal(a.function, "*");
  assert.deepEqual(a.testedBy, ["tests/test_a.py"]);
  assert.deepEqual(b.testedBy, []);
  assert.equal(map.untestedFunctions, 1);
  assert.equal(map.testedFunctions, 1);
});

test("a scoped test map keeps only the graph's functions inside the folder, and its counters follow", async () => {
  const files = {
    "src/billing/a.py": "def charge(): pass\n",
    "src/other/b.py": "def refund(): pass\n",
    "tests/test_billing.py": "def test_charge():\n    charge()\n",
    "system/graph/graph.json": JSON.stringify({ files: [
      { path: "src/billing/a.py", name: "a.py", functions: [{ name: "charge", line: 1 }], usedBy: [], imports: [] },
      { path: "src/other/b.py", name: "b.py", functions: [{ name: "refund", line: 1 }], usedBy: [], imports: [] },
    ] }),
  };
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "pytest", command: "pytest", languages: ["py"] }] };
  const now = new Date("2026-01-01T00:00:00Z");
  const all = await m.buildTestMap(mem(files), "", structure, "system/graph/graph.json", now);
  assert.equal(all.entries.length, 2);
  const scoped = await m.buildTestMap(mem(files), "", structure, "system/graph/graph.json", now, "src/billing");
  assert.deepEqual(scoped.entries.map((e) => e.path), ["src/billing/a.py"]);
  assert.equal(scoped.entries[0].testedBy[0], "tests/test_billing.py", "a test outside the folder still counts for it");
  assert.equal(scoped.testedFunctions, 1);
  assert.equal(scoped.untestedFunctions, 0);
});

test("a scoped test map of a graph's nodes keeps only the nodes inside the folder", async () => {
  const files = {
    "src/billing/a.py": "def charge(): pass\n",
    "src/other/b.py": "def refund(): pass\n",
    "system/graph/graph.json": JSON.stringify({ nodes: [
      { kind: "function", title: "charge", metadata: { path: "src/billing/a.py", line: 1 } },
      { kind: "function", title: "refund", metadata: { path: "src/other/b.py", line: 1 } },
    ] }),
  };
  const structure = { generatedAt: "", status: "missing", notes: [], roots: [] };
  const scoped = await m.buildTestMap(mem(files), "", structure, "system/graph/graph.json", new Date("2026-01-01T00:00:00Z"), "src/billing");
  assert.equal(scoped.source, "graph");
  assert.deepEqual(scoped.entries.map((e) => e.function), ["charge"]);
  assert.equal(scoped.untestedFunctions, 1);
});

test("a scoped test map without a graph lists only the source files inside the folder", async () => {
  const files = {
    "src/billing/a.py": "def charge(): pass\n",
    "src/other/b.py": "def refund(): pass\n",
    "tests/test_billing.py": "def test_charge():\n    charge()\n",
  };
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "pytest", command: "pytest", languages: ["py"] }] };
  const now = new Date("2026-01-01T00:00:00Z");
  const scoped = await m.buildTestMap(mem(files), "", structure, "system/graph/none.json", now, "src/billing");
  assert.equal(scoped.source, "files");
  assert.deepEqual(scoped.entries.map((e) => e.path), ["src/billing/a.py"]);
  assert.equal(scoped.untestedFiles, 1);
  assert.equal(scoped.untestedFunctions, 1);
});
