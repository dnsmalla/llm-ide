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
