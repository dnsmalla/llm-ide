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

test("a start that never ran drains only what queued behind it, and nothing while the editor has unsaved changes", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  const wrapper = src.slice(src.indexOf("const executeLoop = async"), src.indexOf("const runLoop ="));
  // Only ids recorded while the gate was held are eligible; a restored queue (never recorded) waits for Resume.
  assert.match(wrapper, /else \{ waitingRef\.current\.add\(target\.id\); enqueueLoop\(target, scheduled\); \}/);
  assert.match(wrapper, /findIndex\(\(x\) => waiting\.has\(x\.loop\.id\)\)/);
  assert.doesNotMatch(wrapper, /queueRef\.current\.shift\(\)/, "the head of the queue is never taken blindly");
  assert.match(wrapper, /if \(!ranRef\.current && !unmountedRef\.current && !dirtyRef\.current\)/);
});

test("what is left after a run's drain still waits behind the next start, so a start that fails moves on", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  // The run-end drain hands the rest of the queue to waitingRef...
  assert.match(src, /waitingRef\.current = new Set\(next \? queueRef\.current\.map\(\(x\) => x\.loop\.id\) : \[\]\);/);
  // ...and the wrapper, which runs after it, does not wipe that when the start was a real run.
  const wrapper = src.slice(src.indexOf("const executeLoop = async"), src.indexOf("const runLoop ="));
  assert.match(wrapper, /if \(!ranRef\.current\) waitingRef\.current = new Set\(\);/);
  assert.doesNotMatch(wrapper, /\n\s*waitingRef\.current = new Set\(\);\n/, "no unconditional reset");
});
