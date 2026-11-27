import { test } from "node:test";
import assert from "node:assert/strict";
import { loopRunItem } from "../native/run-manager.ts";

test("a board run becomes one run item whose key names the loop; the input path and task ride on the request", () => {
  const item = loopRunItem({ id: "L", name: "Test" }, { command: "do x", inputPath: "lib" });
  assert.equal(item.key, "loop:L");
  assert.equal(item.title, "Test");
  assert.deepEqual(item.loop, { loopId: "L", command: "do x", inputPath: "lib" });
  assert.deepEqual(loopRunItem({ id: "L", name: "Test" }).loop, { loopId: "L" }, "a Loop-page run never pins an input path");
});
