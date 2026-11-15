// deploy/remote/loop-native/*.ts are byte-copies of ui/screens/loop/native/*.ts that ship to the VPS. Nothing
// else keeps them in step, so a fix to the desktop copy silently never reaches remote Loop runs. Fail on drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const remoteDir = path.join(root, "deploy/remote/loop-native");
const uiDir = path.join(root, "ui/screens/loop/native");

const copies = fs.readdirSync(remoteDir).filter((name) => name.endsWith(".ts"));

test("the remote loop-native folder has TypeScript copies to check", () => {
  assert.ok(copies.length > 0);
});

for (const name of copies) {
  test(`deploy/remote/loop-native/${name} matches ui/screens/loop/native/${name}`, () => {
    const source = path.join(uiDir, name);
    assert.ok(fs.existsSync(source), `${name} has no counterpart in ui/screens/loop/native`);
    assert.equal(
      fs.readFileSync(path.join(remoteDir, name), "utf8"),
      fs.readFileSync(source, "utf8"),
      `${name} drifted: copy ui/screens/loop/native/${name} over deploy/remote/loop-native/${name}`,
    );
  });
}
