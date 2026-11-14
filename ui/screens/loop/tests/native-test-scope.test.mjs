import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeStructure } from "../native/stage-exec.ts";

test("a nested test root keeps its plan at the repository root and runs in the nested folder", () => {
  const s = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "", testDir: "tests", runner: "pytest", command: "python3 -m pytest", languages: ["py"] }] };
  const out = scopeStructure(s, "code/llm-ide_test");
  assert.equal(out.roots[0].packageDir, "code/llm-ide_test");
  assert.equal(out.roots[0].testDir, "code/llm-ide_test/tests");
  assert.equal(out.roots[0].command, "cd code/llm-ide_test && python3 -m pytest");
});

test("a package inside the input path keeps both directory levels", () => {
  const s = { generatedAt: "", status: "ok", notes: [], roots: [{ packageDir: "web", testDir: "web/tests", runner: "jest", command: "cd web && npm test", languages: ["js"] }] };
  const out = scopeStructure(s, "code/app");
  assert.equal(out.roots[0].packageDir, "code/app/web");
  assert.equal(out.roots[0].testDir, "code/app/web/tests");
  assert.equal(out.roots[0].command, "cd code/app/web && npm test");
});
