import { test } from "node:test";
import assert from "node:assert/strict";
import { REVIEW_ROOTS, closeReviewTab, decodeEntries, decodeFile, listTruncation, openFolderChildren, pickLinkedRepo, readChildren, refreshGate, safeReviewPath, type ReviewEntry } from "../review-model.ts";

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

test("a refresh keeps open folders' rows: fresh for re-listed, previous for folders opened mid-refresh, none for closed", () => {
  const e = (name: string): ReviewEntry => ({ name, path: `code/${name}`, kind: "file" });
  const fresh = new Map([["code/src", [e("a.ts")]]]);
  const previous = new Map<string, ReviewEntry[]>([["code/src", [e("old.ts")]], ["code/lib", [e("b.ts")]], ["code/closed", [e("c.ts")]]]);
  // code/lib was opened while the refresh ran (not in the snapshot), code/closed was closed meanwhile.
  const kept = openFolderChildren(["code/src", "code/lib"], fresh, previous);
  assert.deepEqual([...kept.keys()], ["code/src", "code/lib"]);
  assert.deepEqual(kept.get("code/src")!.map((x) => x.name), ["a.ts"], "re-listed folder takes the fresh rows");
  assert.deepEqual(kept.get("code/lib")!.map((x) => x.name), ["b.ts"], "a folder opened during the refresh is not wiped");
  assert.equal(kept.has("code/closed"), false);
  assert.equal(openFolderChildren(["code/none"], fresh, previous).has("code/none"), false, "no rows yet: nothing to show");
});

test("overlapping refreshes: only the latest may commit", () => {
  const g = refreshGate();
  const first = g.begin();
  const second = g.begin();
  assert.equal(g.isCurrent(first), false, "the older refresh finishing last must not overwrite the newer one");
  assert.equal(g.isCurrent(second), true);
});

test("a listing that says rows follow reports how many it showed and the host's total", () => {
  assert.deepEqual(listTruncation({ entries: [{}, {}], total: 812, next_offset: 2 }), { shown: 2, total: 812 });
  assert.deepEqual(listTruncation({ entries: [{}], next_offset: 1 }), { shown: 1, total: null });
  assert.equal(listTruncation({ entries: [{}], total: 1, next_offset: null }), null, "a complete listing has no note");
  assert.equal(listTruncation(null), null);
});
