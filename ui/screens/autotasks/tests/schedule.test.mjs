import assert from "node:assert/strict";
import test from "node:test";
import { createCustomTask, saveCustomTasks } from "../native/custom.ts";
import { saveState } from "../native/model.ts";
import { appendCustomRun, CUSTOM_RUNS_KEY, readCustomRuns, runDueCustomTasks } from "../native/custom-schedule.ts";
import { releaseAutoTask, tryAcquireAutoTask } from "../native/lock.ts";

function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), clear: () => map.clear(), map };
}
const ROOT = "/schedule/project";
const NOW = new Date("2026-11-05T02:00:10");

test("scheduler fires once per minute even when the fired write fails", async () => {
  const s = storage();
  saveState({ masterEnabled: true, configs: {} }, s);
  const task = createCustomTask(ROOT, { name: "Once", prompt: "review", mode: "review", cron: "0 * * * *" }, "custom-sched-once");
  saveCustomTasks([task], ROOT, s);
  s.setItem = (k, v) => { if (k === "llmide.customAutoTaskFired.v1") throw new Error("quota"); return s.map.set(k, v); };
  let runs = 0;
  const run = async () => { runs++; return { ok: true, reply: "ok", writes: [] }; };
  assert.equal(await runDueCustomTasks(ROOT, { storage: s, now: NOW, run }), 1);
  assert.equal(await runDueCustomTasks(ROOT, { storage: s, now: NOW, run }), 0);
  assert.equal(runs, 1);
});

test("scheduler stops a batch after a project switch", async () => {
  const s = storage();
  saveState({ masterEnabled: true, configs: {} }, s);
  const one = createCustomTask(ROOT, { name: "One", prompt: "one", mode: "review", cron: "0 * * * *" }, "custom-sched-one");
  const two = createCustomTask(ROOT, { name: "Two", prompt: "two", mode: "review", cron: "0 * * * *" }, "custom-sched-two");
  saveCustomTasks([one, two], ROOT, s);
  let runs = 0;
  const count = await runDueCustomTasks(ROOT, { storage: s, now: NOW, run: async () => { runs++; return { ok: true, reply: "ok", writes: [] }; }, shouldStop: () => runs >= 1 });
  assert.equal(count, 1);
  assert.equal(runs, 1);
});

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


test("scheduler does not arm a due task while another run holds the shared lock", async () => {
  const s = storage();
  saveState({ masterEnabled: true, configs: {} }, s);
  const task = createCustomTask(ROOT, { name: "Locked", prompt: "review", mode: "review", cron: "0 * * * *" }, "custom-sched-lock");
  saveCustomTasks([task], ROOT, s);
  assert.equal(tryAcquireAutoTask(), true);
  let runs = 0;
  try {
    assert.equal(await runDueCustomTasks(ROOT, { storage: s, now: NOW, run: async () => { runs++; return { ok: true, reply: "ok", writes: [] }; } }), 0);
    assert.equal(runs, 0);
  } finally { releaseAutoTask(); }
});
