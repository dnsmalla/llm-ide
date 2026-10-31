import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const { safeRelativePath, relativeToProject } = await load("bus.ts");

test("safeRelativePath rejects ':' and every control character", () => {
  for (const bad of ["a:b", "file.txt:stream", "C:x", "a\nb", "a\tb", "a\u001bb", "a\u007fb", "a\0b", "../x", "/x", "a/../b"]) assert.equal(safeRelativePath(bad), null, JSON.stringify(bad));
  assert.equal(safeRelativePath("src//a/./b.ts"), "src/a/b.ts");
  assert.equal(safeRelativePath("a\\b.ts"), "a/b.ts");
});

test("relativeToProject: Windows roots compare case-insensitively without length drift", () => {
  assert.equal(relativeToProject("c:/Proj/src/a.ts", "C:\\proj"), "src/a.ts");
  assert.equal(relativeToProject("C:/projX/a.ts", "C:/proj"), null);
  assert.equal(relativeToProject("/other/a.ts", "/proj"), null);
  assert.equal(relativeToProject("/proj/src/a.ts", "/proj/"), "src/a.ts");
  assert.equal(relativeToProject("/PROJ/a.ts", "/proj"), null, "POSIX stays case-sensitive");
  // 'İ' lowercases to two UTF-16 units; the slice must still land on the right character.
  assert.equal(relativeToProject("C:/İx/a.ts", "C:/İx"), "a.ts");
});
