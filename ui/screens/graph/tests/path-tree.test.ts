import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TREE_FILES, buildPathTree, fileCount, graphFiles } from "../path-tree.ts";

test("graph files: unique, canonical, bounded, unsafe paths dropped", () => {
  const files = graphFiles(["code/b.ts", "code/a.ts", "./code/a.ts", "/etc/passwd", "code/../x", "code/a.ts", null, "code//b.ts"]);
  assert.deepEqual(files, ["code/a.ts", "code/b.ts"], "relative, unique, no . or .. or absolute paths");
  const many = Array.from({ length: MAX_TREE_FILES + 50 }, (_, i) => `f${i}.ts`);
  assert.equal(graphFiles(many).length, MAX_TREE_FILES);
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
