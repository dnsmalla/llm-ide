import { test } from "node:test";
import assert from "node:assert/strict";
import { scanTestPrune, renderTestPrune, writeTestPrune } from "../native/testprune.ts";

function mem(files) {
  return {
    async read(p) { if (!(p in files)) throw Object.assign(new Error("missing"), { code: "missing" }); return { status: "ok", text: files[p] }; },
    async list(dir) { const prefix = dir === "." ? "" : `${dir}/`; const names = new Map(); for (const p of Object.keys(files)) { if (!p.startsWith(prefix)) continue; const rest = p.slice(prefix.length); const seg = rest.split("/")[0]; names.set(seg, rest.includes("/") ? "dir" : "file"); } if (!names.size && dir !== ".") throw Object.assign(new Error("missing"), { code: "missing" }); return { entries: [...names].map(([name, kind]) => ({ name, kind, path: `${prefix}${name}` })) }; },
    async write() {}, async create() {},
  };
}

test("test prune reports missing assertions, commented and focused tests without editing", async () => {
  const fs = mem({
    "tests/math.test.ts": "test('adds', () => { expect(add(1,2)).toBe(3) })",
    "tests/empty.test.ts": "test('nothing', () => {})",
    "tests/old.test.ts": "// test('old', () => {})\ntest.only('new', () => { expect(1).toBe(1) })",
  });
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "npm", command: "npm test", languages: ["ts"] }] };
  const findings = await scanTestPrune(fs, "", structure);
  const reasons = findings.map((f) => f.reason);
  assert.ok(reasons.includes("noAssertion"));
  assert.ok(reasons.includes("commentedOutTest"));
  assert.ok(reasons.includes("focusedTest"));
  assert.match(renderTestPrune(findings), /Report only/);
});

test("F1: TEST-PRUNE is rewritten on each run instead of failing as already existing", async () => {
  const files = {};
  const fs = {
    ...mem({}),
    async write(path, text, opts) { if (path in files && !opts.force) throw Object.assign(new Error("the file already exists"), { code: "exists" }); files[path] = text; },
  };
  await writeTestPrune(fs, "", []);
  await writeTestPrune(fs, "", [{ path: "tests/x.test.ts", reason: "noAssertion" }]);
  assert.match(files["llm-doc/loop/test/TEST-PRUNE.md"], /tests\/x\.test\.ts/);
});

test("F7: a main-tree prune scan does not descend into other runs' worktrees", async () => {
  const fs = mem({
    "tests/orphan.test.ts": "test('x', () => { expect(1).toBe(1) })",
    "system/loop-worktrees/r1/src/orphan.ts": "export const orphan = 1;",
  });
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "npm", command: "npm test", languages: ["ts"] }] };
  const findings = await scanTestPrune(fs, "", structure);
  assert.deepEqual(findings, [{ path: "tests/orphan.test.ts", reason: "sourceGone" }]);
});

test("the prune walk keeps code files only: 20,000 data files neither stop it nor hide a source file", async () => {
  const folders = { "": [{ name: "tests", path: "tests", kind: "dir" }, { name: "src", path: "src", kind: "dir" }, { name: "data", path: "data", kind: "dir" }], tests: [{ name: "math.test.ts", path: "tests/math.test.ts", kind: "file" }], src: [{ name: "math.ts", path: "src/math.ts", kind: "file" }], data: Array.from({ length: 20_000 }, (_, i) => ({ name: `d${i}.json`, path: `data/d${i}.json`, kind: "file" })) };
  const fs = {
    async read(p) { return { status: "ok", text: p === "tests/math.test.ts" ? "test('adds', () => { expect(1).toBe(1) })" : "" }; },
    async list(dir) { const entries = folders[dir === "." ? "" : dir]; if (!entries) throw Object.assign(new Error("missing"), { code: "missing" }); return { entries }; },
    async write() {}, async create() {},
  };
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "npm", command: "npm test", languages: ["ts"] }] };
  const notes = [];
  assert.deepEqual(await scanTestPrune(fs, "", structure, notes), [], "math.ts is found, so the test is not source-gone");
  assert.deepEqual(notes, []);
});

test("a prune walk over more code files than the limit says the scan is incomplete", async () => {
  const folders = { "": [{ name: "src", path: "src", kind: "dir" }], src: Array.from({ length: 20_001 }, (_, i) => ({ name: `m${i}.py`, path: `src/m${i}.py`, kind: "file" })) };
  const fs = { async read() { return { status: "ok", text: "" }; }, async list(dir) { const entries = folders[dir === "." ? "" : dir]; if (!entries) throw Object.assign(new Error("missing"), { code: "missing" }); return { entries }; }, async write() {}, async create() {} };
  const structure = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "pytest", command: "python3 -m pytest", languages: ["py"] }] };
  const notes = [];
  await scanTestPrune(fs, "", structure, notes);
  assert.deepEqual(notes, ["stopped after 20000 files; the map is incomplete"]);
});
