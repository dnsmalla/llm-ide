import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_ROOTS, closeReviewTab, decodeEntries, decodeFile, pickLinkedRepo, readChildren, safeReviewPath } from "../review-model.ts";

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

test("closing the active tab activates the tab that slides into its slot, else the last", () => {
  assert.deepEqual(closeReviewTab(["a", "b", "c"], "b", "b"), { tabs: ["a", "c"], active: "c" });
  assert.deepEqual(closeReviewTab(["a", "b", "c"], "c", "c"), { tabs: ["a", "b"], active: "b" });
  assert.deepEqual(closeReviewTab(["a", "b"], "a", "a"), { tabs: ["b"], active: "b" });
  assert.deepEqual(closeReviewTab(["a"], "a", "a"), { tabs: [], active: null });
  assert.deepEqual(closeReviewTab(["a", "b"], "b", "a"), { tabs: ["b"], active: "b" });
});

test("a failed folder listing reads as an empty folder", async () => {
  const rows = await readChildren(async () => ({ entries: [{ name: "x.ts", path: "code/x.ts", kind: "file" }] }), "code");
  assert.deepEqual(rows.map((r) => r.name), ["x.ts"]);
  assert.deepEqual(await readChildren(async () => { throw new Error("gone"); }, "code/src"), []);
});

test("the linked repo is the active, cloned GitLab repo first, then GitHub", () => {
  const row = (over: Record<string, unknown>) => ({ displayName: "", url: "https://x/y", clonePath: "", active: false, ...over });
  assert.equal(pickLinkedRepo({ github: [row({ displayName: "gh", clonePath: "/gh", active: true })], gitlab: [row({ displayName: "gl", clonePath: "/gl", active: true })] })?.label, "gl");
  assert.deepEqual(pickLinkedRepo({ github: [row({ displayName: "gh", clonePath: "/gh", active: true })], gitlab: [] }), { label: "gh", path: "/gh" });
  // Active but never cloned is not linked, as the Mac's isCloned rule.
  assert.equal(pickLinkedRepo({ github: [row({ active: true, clonePath: "  " })], gitlab: [] }), null);
  assert.equal(pickLinkedRepo({ github: [], gitlab: [] }), null);
});
