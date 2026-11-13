import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const screen = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../native/native-loop.css", import.meta.url), "utf8");

test("the unsaved Save action sits in the Run header and is red", () => {
  assert.match(screen, /loop-run-tabs/);
  assert.match(screen, /dirty \? <button type="button" className="loop-btn loop-save-btn" data-dirty="true"/);
  assert.match(css, /\.loop-save-btn\[data-dirty="true"\]\s*\{[^}]*var\(--tok-color-danger\)/);
});
