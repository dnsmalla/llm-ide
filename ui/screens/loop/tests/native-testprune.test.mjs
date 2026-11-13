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
