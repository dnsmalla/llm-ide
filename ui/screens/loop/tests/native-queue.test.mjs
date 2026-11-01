import { test } from "node:test";
import assert from "node:assert/strict";
import { loadQueue, saveQueue, clearQueue } from "../native/queue.ts";

test("Loop queue persists ids per project and clears", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  saveQueue("/p", [{ loopId: "a", scheduled: false, at: "t" }, { loopId: "b", scheduled: true, at: "t" }], storage);
  assert.deepEqual(loadQueue("/p", storage).map((x) => x.loopId), ["a", "b"]);
  assert.deepEqual(loadQueue("/other", storage), []);
  clearQueue("/p", storage);
  assert.deepEqual(loadQueue("/p", storage), []);
});
