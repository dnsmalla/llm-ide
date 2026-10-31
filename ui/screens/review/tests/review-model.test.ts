import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_ROOTS, decodeEntries, decodeFile, safeReviewPath } from "../review-model.ts";

test("roots are the Mac's ReviewConfig categories", () => {
  assert.deepEqual(REVIEW_ROOTS.map((r) => r.path), ["code", "llm-doc"]);
});

test("safe paths reject absolute, dot and control-character paths", () => {
  assert.equal(safeReviewPath("code/src/a.ts"), "code/src/a.ts");
  assert.equal(safeReviewPath(" code//src/a.ts "), "code/src/a.ts");
  for (const bad of ["", "/etc/passwd", "code/../x", "a/\u0000b"]) assert.equal(safeReviewPath(bad), null, bad);
});

test("entries are filtered, sorted folders-first, and capped", () => {
  const out = decodeEntries({ entries: [
    { name: "b.ts", path: "code/b.ts", kind: "file" },
    { name: "src", path: "code/src", kind: "dir" },
    { name: "a.ts", path: "code/a.ts", kind: "file" },
    { name: "hidden", path: "code/.x", kind: "file", hidden: true },
    { name: "link", path: "code/l", kind: "file", symlink: true },
    { name: "weird", path: "code/w", kind: "socket" },
  ] });
  assert.deepEqual(out.map((e) => e.name), ["src", "a.ts", "b.ts"]);
});

test("a binary or too-large read has no text", () => {
  assert.deepEqual(decodeFile({ status: "ok", text: "hi", size: 2 }), { text: "hi", bytes: 2 });
  assert.equal(decodeFile({ status: "binary", text: null, size: 9 }), null);
  assert.equal(decodeFile({ status: "too_large", text: null, size: 99999999 }), null);
});
