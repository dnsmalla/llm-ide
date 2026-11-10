import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTaskRun, readTaskRuns, runLabel, TASK_RUNS_KEY } from "../run-history.ts";

function mem() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), map: m };
}
const run = (over) => ({ id: "r1", task: "Review Code", at: "2026-11-10T10:00:00.000Z", ok: true, summary: "ok", durationSeconds: 3, ...over });

test("a run keeps its registry id, and a record from before Task 15 still reads", () => {
  const s = mem();
  s.setItem(TASK_RUNS_KEY, JSON.stringify([run({ id: "old" })]));
  appendTaskRun(run({ id: "new", taskId: "review.code" }), s);
  const back = readTaskRuns(s);
  assert.deepEqual(back.map((r) => r.id), ["new", "old"]);
  assert.equal(back[0].taskId, "review.code");
  assert.equal(back[1].taskId, undefined);
});

test("the label comes from the registry by id, so a stored old label does not break history", () => {
  assert.equal(runLabel(run({ taskId: "review.code", task: "Review (old name)" })), "Review Code");
  assert.equal(runLabel(run({ taskId: "sources.update", task: "Source Update" })), "Source Update");
  assert.equal(runLabel(run({ task: "Renamed long ago" })), "Renamed long ago", "no id: the stored label");
  assert.equal(runLabel(run({ taskId: "gone.task", task: "Gone" })), "Gone", "an id the registry no longer has: the stored label");
});

test("a stored run list this build cannot read is treated as empty and left untouched", () => {
  const s = mem();
  s.setItem(TASK_RUNS_KEY, "{broken");
  assert.deepEqual(readTaskRuns(s), []);
  assert.equal(s.getItem(TASK_RUNS_KEY), "{broken");
});
