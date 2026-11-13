import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedPath, protectedPaths, isCiHookPath, sensitiveChangedFiles } from "../native/protected.ts";

test("protected paths cover tests, build config and Loop state", () => {
  assert.equal(isProtectedPath("Tests/A.swift"), true);
  assert.equal(isProtectedPath("src/foo.test.ts"), true);
  assert.equal(isProtectedPath("package.json"), true);
  assert.equal(isProtectedPath("system/loop.json"), true);
  assert.equal(isProtectedPath("src/app.ts"), false);
  assert.deepEqual(protectedPaths(["src/app.ts", "Tests/A.swift"], []), ["Tests/A.swift"]);
  assert.equal(isProtectedPath("Tests/A.swift", ["!Tests/A.swift"]), false);
});

test("A5: CI and hook files are protected for everyone, case-insensitively", () => {
  for (const p of [".github/workflows/ci.yml", "pkg/.github/workflows/ci.yml", ".gitlab-ci.yml", "sub/.gitlab-ci.yml", ".husky/pre-commit", ".circleci/config.yml", "lefthook.yml", "nested/lefthook.yml", ".pre-commit-config.yaml"]) {
    assert.equal(isProtectedPath(p), true, p);
    assert.equal(isCiHookPath(p), true, p);
    assert.equal(isCiHookPath(p.toUpperCase()), true, `${p} in another case`);
  }
  for (const p of [".github/ISSUE_TEMPLATE/x.md", "src/ci.yml", ".huskyrc", "lefthook.yaml", "docs/lefthook.yml.md"]) assert.equal(isCiHookPath(p), false, p);
  assert.equal(isProtectedPath("package.json", []), true, "build config stays protected");
  assert.equal(isCiHookPath("package.json"), false);
});

test("A5: the Ship panel lists sensitive files changed (build config, CI, hooks) but not tests", () => {
  assert.deepEqual(sensitiveChangedFiles(["package.json", "src/a.ts", "Makefile", ".github/workflows/ci.yml", ".husky/pre-commit", "tests/a.test.ts", "lefthook.yml"]), ["package.json", "Makefile", ".github/workflows/ci.yml", ".husky/pre-commit", "lefthook.yml"]);
  assert.deepEqual(sensitiveChangedFiles(["src/a.ts"]), []);
});

test("scope globs flag changed paths that match none of them; blank or empty globs are unrestricted", async () => {
  const { outOfScopePaths } = await import("../native/protected.ts");
  assert.deepEqual(outOfScopePaths(["src/a.ts", "docs/x.md"], []), []);
  assert.deepEqual(outOfScopePaths(["src/a.ts", "docs/x.md"], ["  ", ""]), []);
  assert.deepEqual(outOfScopePaths(["src/a.ts", "src/deep/b.ts", "docs/x.md"], ["src/**"]), ["docs/x.md"]);
  assert.deepEqual(outOfScopePaths(["src/a.ts"], ["lib/**", "src/a.ts"]), []);
});

test("a scope entry with no glob character, or a trailing slash, is a directory prefix (the Mac's GlobMatch)", async () => {
  const { outOfScopePaths } = await import("../native/protected.ts");
  assert.deepEqual(outOfScopePaths(["src/a.ts", "src/deep/b.ts", "srcx/c.ts", "docs/x.md"], ["src/"]), ["srcx/c.ts", "docs/x.md"]);
  assert.deepEqual(outOfScopePaths(["src/a.ts", "src/deep/b.ts", "srcx/c.ts"], ["src"]), ["srcx/c.ts"]);
  assert.deepEqual(outOfScopePaths(["README.md", "a/README.md"], ["*.md"]), ["a/README.md"]);
});

test("a path dirty before the agent call (the user's edit, or inside an untracked dir) is never revertable", async () => {
  const { wasDirtyBefore } = await import("../native/protected.ts");
  const before = new Set(["src/user edit.ts", "scratch/", "日本.txt"]);
  assert.equal(wasDirtyBefore("src/user edit.ts", before), true);
  assert.equal(wasDirtyBefore("scratch/notes/a.md", before), true);
  assert.equal(wasDirtyBefore("日本.txt", before), true);
  assert.equal(wasDirtyBefore("src/agent.ts", before), false);
  assert.equal(wasDirtyBefore("scratchy.md", before), false);
});

test("R2: a directory entry (git's untracked folder, 'dir/') is protected when a protected glob lies under it", () => {
  assert.equal(isProtectedPath(".github/"), true);
  assert.equal(isProtectedPath("sub/.github/"), true);
  assert.equal(isProtectedPath("tests/"), true);
  assert.equal(isProtectedPath("src/"), false);
  assert.equal(isProtectedPath("docs/"), false);
});

test("R2: isTestPath matches the test globs only, and the default list is built from them", async () => {
  const { isTestPath, TEST_FILE_GLOBS, DEFAULT_PROTECTED_GLOBS } = await import("../native/protected.ts");
  for (const p of ["tests/test_tax.py", "src/a.test.ts", "pkg/__tests__/b.js", "Tests/A.swift", "x_test.go"]) assert.equal(isTestPath(p), true, p);
  for (const p of ["src/app.ts", "pyproject.toml", "package.json", "docs/testing.md"]) assert.equal(isTestPath(p), false, p);
  assert.ok(TEST_FILE_GLOBS.every((g) => DEFAULT_PROTECTED_GLOBS.includes(g)), "the default list is built from the test globs");
});

test("a new untracked CI folder is a CI/hook path, so even Factory Implement cannot add a pipeline", () => {
  for (const p of [".github/", "sub/.github/", ".husky/", ".github/workflows/ci.yml"]) assert.equal(isCiHookPath(p), true, p);
  for (const p of ["src/", "tests/", "docs/ci.md"]) assert.equal(isCiHookPath(p), false, p);
});
