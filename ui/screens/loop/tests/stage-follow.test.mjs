import { test } from "node:test";
import assert from "node:assert/strict";
import { stageIdForLogLine } from "../native/stage-follow.ts";

const stages = [
  { id: "a", name: "Refactor Structure", enabled: true },
  { id: "b", name: "Refactor Plan", enabled: true },
  { id: "off", name: "Refactor Apply", enabled: false },
];

test("a stage start selects that stage", () => {
  assert.equal(stageIdForLogLine(stages, "$ Refactor Plan"), "b");
  assert.equal(stageIdForLogLine(stages, "$ Refactor Structure"), "a");
});

test("non-stage lines and disabled stages do not change the selection", () => {
  assert.equal(stageIdForLogLine(stages, "Refactor Plan"), null);
  assert.equal(stageIdForLogLine(stages, "$ Refactor Apply"), null);
  assert.equal(stageIdForLogLine(stages, "$ Unknown"), null);
});

test("the stage executor logs through the follow callback", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  assert.match(src, /createStageDeps\(\{ \.\.\.stageContext\(/);
  assert.match(src, /log: followLog \}, target\)/);
});
