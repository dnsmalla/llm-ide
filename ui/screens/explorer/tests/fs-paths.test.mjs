import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./helpers.mjs";

const F = await load("fs.ts");

test("the project title is the root's own last segment on macOS, Linux and Windows roots", () => {
  assert.equal(F.nativeBaseName("/Users/me/llm-ide"), "llm-ide");
  assert.equal(F.nativeBaseName("/Users/me/llm-ide/"), "llm-ide");
  assert.equal(F.nativeBaseName("C:\\Users\\me\\proj"), "proj");
  assert.equal(F.nativeBaseName("C:\\Users\\me\\proj\\"), "proj");
  assert.equal(F.nativeBaseName("/"), "");
});

test("Copy Absolute Path joins with the root's separator (Windows backslash, POSIX slash)", () => {
  assert.equal(F.absolutePathUnder("/home/me/proj", "src/a.ts"), "/home/me/proj/src/a.ts");
  assert.equal(F.absolutePathUnder("/home/me/proj/", "a.txt"), "/home/me/proj/a.txt");
  assert.equal(F.absolutePathUnder("C:\\Users\\me\\proj", "src/a.ts"), "C:\\Users\\me\\proj\\src\\a.ts");
  assert.equal(F.absolutePathUnder("C:\\Users\\me\\proj\\", "a.txt"), "C:\\Users\\me\\proj\\a.txt");
  assert.equal(F.absolutePathUnder("/", "a.txt"), "/a.txt");
});
