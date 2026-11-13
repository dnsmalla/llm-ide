import { test } from "node:test";
import assert from "node:assert/strict";
import { importOnlyFiles } from "../native/import-only.ts";

/** One file's unified diff: `body` is the text after the `@@` line, so callers write the counts they mean. */
const fileDiff = (path, body, header = "") =>
  `diff --git a/${path} b/${path}\n${header}--- a/${path}\n+++ b/${path}\n${body}`;
/** `allowed` is the batch's `- Files:` list; true when this one file is import-only. */
const ok = (diff, path, allowed = []) => importOnlyFiles(diff, [path], allowed).length === 1;

test("a python import that moves a name to a module the batch names is import-only", () => {
  const move = fileDiff("tests/test_a.py", "@@ -1,2 +1,2 @@\n-from shop.old import total\n+from pricing import total\n import os\n");
  assert.equal(ok(move, "tests/test_a.py", ["src/pricing.py"]), true);
  assert.equal(ok(move, "tests/test_a.py", []), false, "the new module must be named by the batch");
  assert.equal(ok(move, "tests/test_a.py", ["src/other.py"]), false, "a different file does not name it");
  const bare = fileDiff("tests/test_a.py", "@@ -1 +1 @@\n-from shop import total\n+from pricing import total\n");
  assert.equal(ok(bare, "tests/test_a.py", ["pricing.py"]), true, "a single-segment module is a bare file");
});

test("a fake module that the batch does not name is rejected, even when the old module is in the batch", () => {
  const fake = fileDiff("tests/test_shop.py", "@@ -1 +1 @@\n-from shop import total\n+from fake import total\n");
  assert.equal(ok(fake, "tests/test_shop.py", ["shop.py"]), false);
  assert.equal(ok(fake, "tests/test_shop.py", []), false);
});

test("a purely added import (even one that skips tests at import time) is never import-only", () => {
  const added = fileDiff("tests/test_a.py", "@@ -1 +1,2 @@\n import os\n+import skipper\n");
  assert.equal(ok(added, "tests/test_a.py", ["skipper.py"]), false);
  const removed = fileDiff("tests/test_a.py", "@@ -1,2 +1 @@\n import os\n-import skipper\n");
  assert.equal(ok(removed, "tests/test_a.py", []), false, "a purely removed import is not a move");
});

test("adding or dropping a name is not a move", () => {
  const adds = fileDiff("tests/test_a.py", "@@ -1 +1 @@\n-from shop import total\n+from pricing import total, tax\n");
  assert.equal(ok(adds, "tests/test_a.py", ["pricing.py"]), false);
  const renamed = fileDiff("tests/test_a.py", "@@ -1 +1 @@\n-from shop import total\n+from pricing import price\n");
  assert.equal(ok(renamed, "tests/test_a.py", ["pricing.py"]), false, "a renamed name changes what the test uses");
  const drops = fileDiff("tests/test_a.py", "@@ -1 +1 @@\n-from shop import total, tax\n+from pricing import total\n");
  assert.equal(ok(drops, "tests/test_a.py", ["pricing.py"]), false);
});

test("python paren-block moves are import-only when the names and the batch line up", () => {
  const block = fileDiff("tests/test_b.py", "@@ -1,4 +1,4 @@\n-from shop import (\n+from pricing import (\n     total,\n-    tax,\n+    tax,\n )\n");
  assert.equal(ok(block, "tests/test_b.py", ["src/pricing.py"]), true, "names inside a block opened on an import line are import lines");
  assert.equal(ok(block, "tests/test_b.py", []), false);
  const ctxOpener = fileDiff("tests/test_c.py", "@@ -1,4 +1,4 @@\n from shop import (\n-    total,\n+    total,\n )\n import os\n");
  assert.equal(ok(ctxOpener, "tests/test_c.py"), true, "a context line can open the block");
  const renamedName = fileDiff("tests/test_b.py", "@@ -1,4 +1,4 @@\n-from shop import (\n+from pricing import (\n     total,\n-    tax,\n+    levy,\n )\n");
  assert.equal(ok(renamedName, "tests/test_b.py", ["pricing.py"]), false, "a name changed inside the block is not a move");
});

test("a paren-block name line that is not an import name is not import-only", () => {
  const bad = fileDiff("tests/test_a.py", "@@ -1,3 +1,3 @@\n from x import (\n-    a,\n+    os.system('rm'),\n )\n");
  assert.equal(ok(bad, "tests/test_a.py", ["x.py"]), false);
});

test("star imports and other lines that do not read as a named import fail closed", () => {
  const star = fileDiff("tests/test_a.py", "@@ -1 +1 @@\n-from shop import total\n+from pricing import *\n");
  assert.equal(ok(star, "tests/test_a.py", ["pricing.py"]), false);
});

test("conftest.py, __init__.py and helpers are never import-only, because they change how every test runs", () => {
  const move = (p) => fileDiff(p, "@@ -1 +1 @@\n-from shop import total\n+from pricing import total\n");
  for (const p of ["tests/conftest.py", "tests/__init__.py", "tests/helpers.py", "tests/fixtures/shim.py"]) {
    assert.equal(ok(move(p), p, ["pricing.py"]), false, p);
  }
});

test("js/ts moves are import-only when the new specifier is a batch file", () => {
  const move = fileDiff("src/a.test.ts", "@@ -1,2 +1,2 @@\n-import { total } from './shop';\n+import { total } from './pricing';\n import x from 'y';\n");
  assert.equal(ok(move, "src/a.test.ts", ["src/pricing.ts"]), true);
  assert.equal(ok(move, "src/a.test.ts", []), false, "the new specifier must be named by the batch");
  const bare = fileDiff("src/a.test.ts", "@@ -1 +1 @@\n-import { total } from './shop';\n+import { total } from 'lodash';\n");
  assert.equal(ok(bare, "src/a.test.ts", ["src/pricing.ts", "lodash.ts"]), false, "a bare package is never named by the plan");
});

test("js default, namespace, require, re-export moves are import-only; side-effect imports never are", () => {
  const ns = fileDiff("src/a.test.ts", "@@ -1 +1 @@\n-import * as t from './shop';\n+import * as t from './pricing';\n");
  assert.equal(ok(ns, "src/a.test.ts", ["src/pricing.ts"]), true);
  const req = fileDiff("src/b.test.js", "@@ -1 +1 @@\n-const { total } = require('./shop');\n+const { total } = require('./pricing');\n");
  assert.equal(ok(req, "src/b.test.js", ["src/pricing.js"]), true);
  const reexp = fileDiff("src/c.test.ts", "@@ -1 +1 @@\n-export { total } from './shop';\n+export { total } from './pricing';\n");
  assert.equal(ok(reexp, "src/c.test.ts", ["src/pricing.ts"]), true);
  const side = fileDiff("tests/a.test.ts", "@@ -1 +1 @@\n-import './old-setup';\n+import './new-setup';\n");
  assert.equal(ok(side, "tests/a.test.ts", ["tests/new-setup.ts"]), false, "a side-effect import binds no name");
  const exportAll = fileDiff("src/d.test.ts", "@@ -1 +1 @@\n-export * from './shop';\n+export * from './pricing';\n");
  assert.equal(ok(exportAll, "src/d.test.ts", ["src/pricing.ts"]), false, "export * exports no name to compare");
});

test("swift imports count as names, so a rename is not a move", () => {
  const swift = fileDiff("Tests/AppTests.swift", "@@ -1 +1 @@\n-import Foo\n+import Bar\n");
  assert.equal(ok(swift, "Tests/AppTests.swift", ["Bar.swift"]), false);
});

test("a body change mixed into an import edit is not import-only", () => {
  const mixed = fileDiff("tests/test_a.py", "@@ -1,3 +1,3 @@\n-from old import a\n+from new import a\n def test_x():\n-    assert a(1) == 2\n+    assert a(1) == 3\n");
  assert.equal(ok(mixed, "tests/test_a.py", ["new.py"]), false);
  const jsBody = fileDiff("tests/a.test.ts", "@@ -1,2 +1,2 @@\n-import a from './a';\n+import a from './b';\n-it('x', () => {});\n+it('y', () => {});\n");
  assert.equal(ok(jsBody, "tests/a.test.ts", ["tests/b.ts"]), false);
});

test("new, deleted, renamed, binary and mode-only files are not import-only", () => {
  const body = "@@ -1 +1 @@\n-from old import a\n+from new import a\n";
  assert.equal(ok(fileDiff("tests/test_a.py", body, "new file mode 100644\n"), "tests/test_a.py", ["new.py"]), false, "new file");
  assert.equal(importOnlyFiles(`diff --git a/tests/test_a.py b/tests/test_a.py\ndeleted file mode 100644\n--- a/tests/test_a.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-import a\n`, ["tests/test_a.py"], []).length, 0, "deleted file");
  const renamed = "diff --git a/tests/old_test.py b/tests/test_new.py\nsimilarity index 90%\nrename from tests/old_test.py\nrename to tests/test_new.py\n--- a/tests/old_test.py\n+++ b/tests/test_new.py\n" + body;
  assert.equal(importOnlyFiles(renamed, ["tests/test_new.py", "tests/old_test.py"], ["new.py"]).length, 0, "rename");
  const binary = "diff --git a/tests/test_a.bin b/tests/test_a.bin\nBinary files a/tests/test_a.bin and b/tests/test_a.bin differ\n";
  assert.equal(importOnlyFiles(binary, ["tests/test_a.bin"], []).length, 0, "binary");
  const mode = "diff --git a/tests/test_a.py b/tests/test_a.py\nold mode 100644\nnew mode 100755\n";
  assert.equal(importOnlyFiles(mode, ["tests/test_a.py"], []).length, 0, "mode only has no changed lines");
});

test("blank-only changes and files with no changed line are not import-only", () => {
  assert.equal(ok(fileDiff("tests/test_a.py", "@@ -1,2 +1,2 @@\n \n-\n+\n x\n"), "tests/test_a.py"), false, "blank lines are not changes");
  assert.equal(ok(fileDiff("tests/test_a.py", "@@ -1,2 +1,2 @@\n-\n+   \n x\n"), "tests/test_a.py"), false, "whitespace-only edit has no import");
});

test("only exact test-named candidates are returned, in candidate order, and a removed line that looks like a file header is still a change", () => {
  const two = fileDiff("tests/test_a.py", "@@ -1 +1 @@\n-from old import a\n+from new import a\n") + fileDiff("tests/test_b.py", "@@ -1 +1 @@\n-from old import c\n+from new import c\n");
  assert.deepEqual(importOnlyFiles(two, ["tests/test_b.py", "tests/test_a.py", "tests/test_other.py", "tests/test_a"], ["new.py"]), ["tests/test_b.py", "tests/test_a.py"]);
  // A removed SQL-style comment looks like a file header; the hunk count keeps it a change, so the file is not import-only.
  const sql = fileDiff("tests/test_x.py", "@@ -1 +1 @@\n--- old comment\n+import b\n");
  assert.equal(ok(sql, "tests/test_x.py"), false);
});

test("swapping the imported name behind the same alias is a change, not a move", () => {
  const diff = "diff --git a/tests/test_a.py b/tests/test_a.py\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-from a import foo as X\n+from a import bar as X\n";
  assert.deepEqual(importOnlyFiles(diff, ["tests/test_a.py"], []), []);
  const moved = "diff --git a/tests/test_a.py b/tests/test_a.py\n--- a/tests/test_a.py\n+++ b/tests/test_a.py\n@@ -1 +1 @@\n-from a import foo as X\n+from b import foo as X\n";
  assert.deepEqual(importOnlyFiles(moved, ["tests/test_a.py"], ["b.py"]), ["tests/test_a.py"], "moving the same name keeps working");
});
