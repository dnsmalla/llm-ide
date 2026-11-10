import assert from "node:assert/strict";
import test from "node:test";
import { appendCustomRun, CUSTOM_RUNS_KEY, readCustomRuns } from "../native/custom-schedule.ts";

// The scheduler itself (due tasks, the shared lock, one at a time, skips, the fired store) is tested in
// ui/screens/tasks/tests/schedule.test.mjs; this file keeps the custom run history it writes.
function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), clear: () => map.clear(), map };
}

test("run history is project-scoped, validated and corrupt-safe", () => {
  const s = storage();
  const run = (root, id, at) => ({ id, taskId: "t", task: id, projectRoot: root, at, ok: true, summary: "ok", trigger: "manual" });
  appendCustomRun(run("/a", "a1", "2026-01-01"), s);
  appendCustomRun(run("/b", "b1", "2026-01-01"), s);
  assert.deepEqual(readCustomRuns(s, "/a").map((r) => r.id), ["a1"]);
  assert.deepEqual(readCustomRuns(s, "/b").map((r) => r.id), ["b1"]);
  s.setItem(CUSTOM_RUNS_KEY, JSON.stringify([null, { id: 1 }]));
  assert.deepEqual(readCustomRuns(s, "/a"), []);
});
