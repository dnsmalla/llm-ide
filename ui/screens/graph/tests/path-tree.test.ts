import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TREE_FILES, buildPathTree, fileCount, graphFiles, totalGraphFiles } from "../path-tree.ts";

test("graph files: unique, canonical, bounded, unsafe paths dropped", () => {
  const files = graphFiles(["code/b.ts", "code/a.ts", "./code/a.ts", "/etc/passwd", "code/../x", "code/a.ts", null, "code//b.ts"]);
  assert.deepEqual(files, ["code/a.ts", "code/b.ts"], "relative, unique, no . or .. or absolute paths");
  const many = Array.from({ length: MAX_TREE_FILES + 50 }, (_, i) => `f${i}.ts`);
  assert.equal(graphFiles(many).length, MAX_TREE_FILES);
  assert.equal(totalGraphFiles(many), MAX_TREE_FILES + 50, "the total is still known when the tree is capped");
  assert.equal(totalGraphFiles(["a.ts", "./a.ts", "/x", null]), 1);
});

test("a capped tree keeps the first files alphabetically, not whichever nodes came first", () => {
  const paths = ["zeta.ts", ...Array.from({ length: MAX_TREE_FILES }, (_, i) => `m/f${String(i).padStart(4, "0")}.ts`), "alpha.ts"];
  const files = graphFiles(paths);
  assert.equal(files.length, MAX_TREE_FILES);
  assert.equal(files[0], "alpha.ts");
  assert.ok(!files.includes("zeta.ts"));
});

test("the tree groups folders first, then files, both alphabetical", () => {
  const root = buildPathTree(["code/src/b.ts", "code/src/a.ts", "code/README.md", "docs/x.md"]);
  assert.deepEqual(root.children.map((c) => `${c.kind}:${c.name}`), ["dir:code", "dir:docs"]);
  const code = root.children[0]!;
  assert.equal(code.kind, "dir");
  if (code.kind !== "dir") return;
  assert.deepEqual(code.children.map((c) => `${c.kind}:${c.name}`), ["dir:src", "file:README.md"]);
  const src = code.children[0]!;
  if (src.kind !== "dir") return;
  assert.deepEqual(src.children.map((c) => c.path), ["code/src/a.ts", "code/src/b.ts"]);
  assert.equal(fileCount(root), 4);
});

test("an empty graph has an empty root and no file rows", () => {
  const root = buildPathTree([]);
  assert.deepEqual(root.children, []);
  assert.equal(fileCount(root), 0);
});

test("graph files sort with the en collator, and the total counts unique clean paths past the cap", () => {
  assert.deepEqual(graphFiles(["B.ts", "a.ts", "b.ts"]), ["a.ts", "b.ts", "B.ts"], "locale order, not code-point order");
  const many = Array.from({ length: MAX_TREE_FILES + 50 }, (_, i) => `f${i}.ts`);
  const dirty = [...many, ...many.slice(0, 10), "./f1.ts", "/abs.ts", null];
  assert.equal(totalGraphFiles(dirty), MAX_TREE_FILES + 50, "the total is the unique clean count, memoised per array");
  assert.equal(fileCount(buildPathTree(dirty)), MAX_TREE_FILES, "the tree shows the capped first files");
});
