import { test } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_ROOTS, decodeProjectEntries, decodeProjectFile, safeProjectPath } from "../project-files.ts";

test("the categories are the Mac Library's Code and Data", () => {
  assert.deepEqual(PROJECT_ROOTS.map((r) => r.path), ["code", "data"]);
});

test("paths are project-relative and entries sorted folders-first", () => {
  assert.equal(safeProjectPath("code/a.ts"), "code/a.ts");
  for (const bad of ["", "/abs", "code/../x", "a/\u0000"]) assert.equal(safeProjectPath(bad), null, bad);
  const out = decodeProjectEntries({ entries: [
    { name: "b.ts", path: "code/b.ts", kind: "file" },
    { name: "src", path: "code/src", kind: "dir" },
    { name: "a.ts", path: "code/a.ts", kind: "file" },
    { name: "h", path: "code/.h", kind: "file", hidden: true },
  ] });
  assert.deepEqual(out.map((e) => e.name), ["src", "a.ts", "b.ts"]);
});

test("the viewer only shows text reads", () => {
  assert.deepEqual(decodeProjectFile({ status: "ok", text: "x", size: 1 }), { text: "x", bytes: 1 });
  assert.equal(decodeProjectFile({ status: "binary", text: null }), null);
  assert.equal(decodeProjectFile(null), null);
});
