import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanCommand, fromQueued, toQueued } from "../native/queue.ts";

const loop = { id: "L", name: "Test", inputPath: "src", config: { stages: [] } };

test("an input-path override and command round-trip; only an explicit override is persisted", () => {
  const q = toQueued({ loop: { ...loop, inputPath: "lib" }, scheduled: false, command: " do\n x ", inputOverride: "lib" }, "t");
  assert.deepEqual(q, { loopId: "L", scheduled: false, at: "t", command: "do x", inputPath: "lib" });
  const r = fromQueued(q, loop);
  assert.equal(r.entry.loop.inputPath, "lib");
  assert.equal(r.entry.command, "do x");
  assert.equal("inputPath" in toQueued({ loop: { ...loop, inputPath: "old" }, scheduled: true }, "t"), false, "a Loop-page run never pins a path");
  assert.equal(r.entry.inputOverride, "lib");
});

test("older entries load as before; an invalid stored override drops the entry", () => {
  const r = fromQueued({ loopId: "L", scheduled: true, at: "t" }, loop);
  assert.deepEqual(r.entry, { loop, scheduled: true });
  assert.match(fromQueued({ loopId: "L", scheduled: false, at: "t", inputPath: "../x" }, loop).error, /Dropped/);
});

test("stored commands are bounded", () => {
  assert.equal(cleanCommand("a".repeat(3000)).length, 2000);
});
