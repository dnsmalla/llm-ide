import { test } from "node:test";
import assert from "node:assert/strict";
import { isProtectedPath, protectedPaths } from "../native/protected.ts";

test("protected paths cover tests, build config and Loop state", () => {
  assert.equal(isProtectedPath("Tests/A.swift"), true);
  assert.equal(isProtectedPath("src/foo.test.ts"), true);
  assert.equal(isProtectedPath("package.json"), true);
  assert.equal(isProtectedPath("system/loop.json"), true);
  assert.equal(isProtectedPath("src/app.ts"), false);
  assert.deepEqual(protectedPaths(["src/app.ts", "Tests/A.swift"], []), ["Tests/A.swift"]);
  assert.equal(isProtectedPath("Tests/A.swift", ["!Tests/A.swift"]), false);
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
