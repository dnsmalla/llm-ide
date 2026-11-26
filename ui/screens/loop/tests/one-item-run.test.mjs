import { test } from "node:test";
import assert from "node:assert/strict";
import { isOneItemRun } from "../native/run-command.ts";

test("a named task makes any non-Factory run one-item", () => {
  assert.equal(isOneItemRun("all", "fix x", false), true);
  assert.equal(isOneItemRun(undefined, "  ", false), false);
  assert.equal(isOneItemRun("one", undefined, false), true, "workMode one stays one-item (the gate then asks for the task)");
  assert.equal(isOneItemRun("all", undefined, false), false);
});

test("a Factory run is never one-item", () => {
  assert.equal(isOneItemRun("one", "x", true), false);
});
