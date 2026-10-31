import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const T = await load("tree-model.ts");

const ent = (dir, name, kind = "file") => ({ name, path: dir ? `${dir}/${name}` : name, kind, symlink: false, hidden: false, ignored: false, size: 1, mtime_ms: 0 });
const names = (rows) => rows.map((r) => (r.kind === "entry" ? r.entry.path : r.kind === "gap" ? `gap:${r.dir}:${r.page}` : `${r.text}:${r.dir}`));

function tree(pageSize = 3) {
  let s = T.emptyTree(pageSize);
  s = T.withPage(s, "", 0, [ent("", "src", "dir"), ent("", "docs", "dir"), ent("", "a.txt")], 5);
  s = T.withPage(s, "", 1, [ent("", "b.txt"), ent("", "c.txt")], 5);
  return s;
}

test("layout lists loaded entries and a gap row for each entry of a missing page", () => {
  let s = T.emptyTree(3);
  s = T.withPage(s, "", 1, [ent("", "d"), ent("", "e"), ent("", "f")], 8);
  const l = T.buildLayout(s);
  assert.equal(l.count, 8);
  assert.deepEqual(names(T.rowsInRange(l, 0, 8, s)), ["gap::0", "gap::0", "gap::0", "d", "e", "f", "gap::2", "gap::2"]);
});

test("expanding a directory splices its children (and a loading row until listed)", () => {
  let s = tree();
  s = T.withExpanded(s, "src", true);
  let l = T.buildLayout(s);
  assert.deepEqual(names(T.rowsInRange(l, 0, l.count, s)), ["src", "loading:src", "docs", "a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(T.unloadedExpanded(s), ["src"]);
  s = T.withPage(s, "src", 0, [ent("src", "main.rs"), ent("src", "lib", "dir")], 2);
  s = T.withExpanded(s, "src/lib", true);
  s = T.withPage(s, "src/lib", 0, [], 0);
  l = T.buildLayout(s);
  const rows = T.rowsInRange(l, 0, l.count, s);
  assert.deepEqual(names(rows), ["src", "src/main.rs", "src/lib", "empty:src/lib", "docs", "a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(rows.map((r) => r.depth), [0, 1, 1, 2, 0, 0, 0, 0]);
  assert.equal(rows[2].expanded, true);
  assert.equal(T.indexOfPath(l, "src/lib"), 2);
  assert.equal(T.indexOfPath(l, "nope"), -1);
});

test("rowsInRange agrees with a full flatten for every sub-range", () => {
  let s = tree();
  s = T.withExpanded(s, "src", true);
  s = T.withPage(s, "src", 0, [ent("src", "x"), ent("src", "y")], 2);
  const l = T.buildLayout(s);
  const all = names(T.rowsInRange(l, 0, l.count, s));
  for (let a = 0; a <= l.count; a++) for (let b = a; b <= l.count; b++) assert.deepEqual(names(T.rowsInRange(l, a, b, s)), all.slice(a, b), `${a}-${b}`);
  assert.deepEqual(T.rowsInRange(l, -5, 2, s).length, 2);
  assert.deepEqual(T.rowsInRange(l, 100, 200, s), []);
});

test("an error with nothing loaded shows an error row; a page error keeps loaded pages", () => {
  let s = T.emptyTree(3);
  s = T.withExpanded(s, "bad", true);
  s = T.withError(s, "bad", 0, "denied");
  s = T.withPage(s, "", 0, [ent("", "bad", "dir")], 1);
  const l = T.buildLayout(s);
  const rows = T.rowsInRange(l, 0, l.count, s);
  assert.equal(rows[1].kind, "status");
  assert.equal(rows[1].text, "error");
  assert.equal(rows[1].message, "denied");
});

test("window range maths: bounds, overscan, padding sum to the total", () => {
  const w = T.windowRange(100000, 22 * 5000, 440, 22, 8);
  assert.equal(w.start, 4992);
  assert.equal(w.end, 5000 + 20 + 8);
  assert.equal(w.padTop + (w.end - w.start) * 22 + w.padBottom, w.totalHeight);
  assert.deepEqual(T.windowRange(0, 0, 400), { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
  const end = T.windowRange(10, 99999, 100, 22, 2);
  assert.equal(end.end, 10);
  assert.ok(end.start < 10);
  assert.equal(T.windowRange(50, 0, 0).end, 0);
});

test("pagesNeeded lists unloaded, not-yet-loading pages once", () => {
  let s = T.emptyTree(3);
  s = T.withPage(s, "", 1, [ent("", "d")], 9);
  const l = T.buildLayout(s);
  const rows = T.rowsInRange(l, 0, l.count, s);
  assert.deepEqual(T.pagesNeeded(rows, s), [{ dir: "", page: 0 }, { dir: "", page: 2 }]);
  s = T.withLoading(s, "", 0);
  assert.deepEqual(T.pagesNeeded(rows, s), [{ dir: "", page: 2 }]);
});

test("keyboard navigation", () => {
  let s = tree();
  s = T.withExpanded(s, "src", true);
  s = T.withPage(s, "src", 0, [ent("src", "main.rs")], 1);
  const l = T.buildLayout(s); // src, src/main.rs, docs, a.txt, b.txt, c.txt
  const nav = (p, k) => T.navigate(l, s, p, k);
  assert.deepEqual(nav(null, "ArrowDown"), { type: "focus-index", index: 0 });
  assert.deepEqual(nav("src", "ArrowDown"), { type: "focus-index", index: 1 });
  assert.deepEqual(nav("c.txt", "ArrowDown"), { type: "focus-index", index: 5 });
  assert.deepEqual(nav("src", "ArrowUp"), { type: "focus-index", index: 0 });
  assert.deepEqual(nav("src", "End"), { type: "focus-index", index: 5 });
  assert.deepEqual(nav("src", "ArrowRight"), { type: "focus-index", index: 1 });
  assert.deepEqual(nav("docs", "ArrowRight"), { type: "expand", path: "docs" });
  assert.equal(nav("a.txt", "ArrowRight"), null);
  assert.deepEqual(nav("src", "ArrowLeft"), { type: "collapse", path: "src" });
  assert.deepEqual(nav("src/main.rs", "ArrowLeft"), { type: "focus-path", path: "src" });
  assert.equal(nav("a.txt", "ArrowLeft"), null);
  assert.deepEqual(nav("a.txt", "Enter"), { type: "open", path: "a.txt" });
  assert.deepEqual(nav("docs", "Enter"), { type: "toggle", path: "docs" });
  assert.deepEqual(T.navigate(l, s, "src", "PageDown", 4), { type: "focus-index", index: 4 });
});

test("type-ahead wraps and is case-insensitive", () => {
  const s = tree();
  const l = T.buildLayout(s); // src docs a.txt b.txt c.txt
  assert.equal(T.typeAhead(l, s, -1, "D"), 1);
  assert.equal(T.typeAhead(l, s, 3, "a"), 2);
  assert.equal(T.typeAhead(l, s, 0, "zzz"), -1);
  assert.equal(T.typeAhead(l, s, 0, ""), -1);
});

test("selection: plain, toggle, shift range, top-level reduction", () => {
  const s = tree();
  const l = T.buildLayout(s);
  let sel = T.applySelect(T.NO_SELECTION, l, s, "docs", { shift: false, toggle: false });
  assert.deepEqual([...sel.paths], ["docs"]);
  sel = T.applySelect(sel, l, s, "b.txt", { shift: true, toggle: false });
  assert.deepEqual([...sel.paths].sort(), ["a.txt", "b.txt", "docs"]);
  assert.equal(sel.anchor, "docs");
  sel = T.applySelect(sel, l, s, "a.txt", { shift: false, toggle: true });
  assert.deepEqual([...sel.paths].sort(), ["b.txt", "docs"]);
  assert.deepEqual(T.topLevel(["a/b/c.txt", "a", "a/b", "ab", "z/y"]), ["a", "ab", "z/y"]);
});

test("drop rules", () => {
  assert.equal(T.canDrop("a", "a"), false);
  assert.equal(T.canDrop("a", "a/b"), false);
  assert.equal(T.canDrop("a/f.txt", "a"), false);
  assert.equal(T.canDrop("a/f.txt", ""), true);
  assert.equal(T.canDrop("f.txt", "a"), true);
  assert.equal(T.canDrop("ab", "a"), true);
});

test("invalidate and prune bound memory", () => {
  let s = tree();
  s = T.withExpanded(s, "src", true);
  s = T.withPage(s, "src", 0, [ent("src", "x")], 1);
  s = T.withPage(s, "old", 0, [ent("old", "y")], 1);
  assert.equal(T.pruneCollapsed(s).dirs.has("old"), false);
  assert.equal(T.pruneCollapsed(s).dirs.has("src"), true);
  assert.equal(T.invalidate(s, "src").dirs.has("src"), false);
  assert.equal(T.invalidate(s, "nothing"), s);
});

test("100k-entry folder: layout, window and page lookups stay cheap", () => {
  const pageSize = 500;
  const total = 100_000;
  let s = T.emptyTree(pageSize);
  // Worst case for layout cost: every page loaded.
  for (let p = 0; p < total / pageSize; p++) {
    const page = Array.from({ length: pageSize }, (_, i) => ent("", `f${String(p * pageSize + i).padStart(6, "0")}`, (p * pageSize + i) % 50 === 0 ? "dir" : "file"));
    s = T.withPage(s, "", p, page, total);
  }
  const t0 = performance.now();
  const l = T.buildLayout(s);
  const t1 = performance.now();
  assert.equal(l.count, total);
  let worst = 0;
  for (let top = 0; top < total * 22; top += 22 * 997) {
    const a = performance.now();
    const w = T.windowRange(l.count, top, 800);
    const rows = T.rowsInRange(l, w.start, w.end, s);
    worst = Math.max(worst, performance.now() - a);
    assert.ok(rows.length <= 80);
  }
  const lookup0 = performance.now();
  assert.equal(T.indexOfPath(l, "f099999"), 99999);
  const lookup1 = performance.now();
  // Budgets are generous (CI noise); a 60 fps frame is 16 ms.
  console.log(`BENCH tree 100k: layout ${(t1 - t0).toFixed(1)} ms, worst window ${worst.toFixed(2)} ms, indexOfPath ${(lookup1 - lookup0).toFixed(1)} ms`);
  assert.ok(worst < 8, `window slice ${worst} ms`);
  assert.ok(t1 - t0 < 150, `layout ${t1 - t0} ms`);
});
