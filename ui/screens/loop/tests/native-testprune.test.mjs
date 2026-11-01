import { test } from "node:test";
import assert from "node:assert/strict";
import { scanTestPrune, renderTestPrune } from "../native/testprune.ts";

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
