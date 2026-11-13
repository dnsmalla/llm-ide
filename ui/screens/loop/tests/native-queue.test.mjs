import { test } from "node:test";
import assert from "node:assert/strict";
import { loadQueue, saveQueue, clearQueue } from "../native/queue.ts";
import { createStartGate } from "../native/start-gate.ts";

test("Loop queue persists ids per project and clears", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  saveQueue("/p", [{ loopId: "a", scheduled: false, at: "t" }, { loopId: "b", scheduled: true, at: "t" }], storage);
  assert.deepEqual(loadQueue("/p", storage).map((x) => x.loopId), ["a", "b"]);
  assert.deepEqual(loadQueue("/other", storage), []);
  clearQueue("/p", storage);
  assert.deepEqual(loadQueue("/p", storage), []);
});

test("the start gate lets one start through until it is released", () => {
  const gate = createStartGate();
  assert.equal(gate.held, false);
  assert.equal(gate.tryAcquire(), true);
  assert.equal(gate.held, true);
  assert.equal(gate.tryAcquire(), false, "a second start in the same tick is refused");
  gate.release();
  assert.equal(gate.tryAcquire(), true);
});

test("every Loop start goes through the gate before its first await, and blocked starts queue", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  const wrapper = src.slice(src.indexOf("const executeLoop = async"), src.indexOf("const runLoop ="));
  assert.ok(wrapper.indexOf("tryAcquire()") < wrapper.indexOf("await "), "the gate is taken before any await");
  assert.match(wrapper, /enqueueLoop\(target, scheduled\)/);
  assert.match(wrapper, /finally \{\s*startGateRef\.current\.release\(\)/);
  assert.match(src, /if \(runningRef\.current \|\| startGateRef\.current\.held\) \{\s*enqueueLoop/);
});
