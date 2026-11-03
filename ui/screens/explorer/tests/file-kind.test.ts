import { test } from "node:test";
import assert from "node:assert/strict";
import { fileKind } from "../file-kind.ts";

test("file kinds follow the Mac FileIconKit families", () => {
  assert.equal(fileKind("main.ts"), "code");
  assert.equal(fileKind("Dockerfile"), "code");
  assert.equal(fileKind("Makefile"), "code");
  assert.equal(fileKind("package.json"), "config");
  assert.equal(fileKind("README.md"), "doc");
  assert.equal(fileKind("logo.svg"), "image");
  assert.equal(fileKind("issues.csv"), "data");
  assert.equal(fileKind("LICENSE"), "other");
  assert.equal(fileKind("anything", true), "folder");
});
