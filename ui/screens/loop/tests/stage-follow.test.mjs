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
