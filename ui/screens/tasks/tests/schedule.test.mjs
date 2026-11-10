import { test } from "node:test";
import assert from "node:assert/strict";
import { dueTasks, runDueScheduled, startTaskScheduler } from "../schedule.ts";
import { defaultTaskState, saveTaskState } from "../store.ts";
import { runTask } from "../runner.ts";
import { createCustomTask, loadCustomTasks, saveCustomTasks } from "../../autotasks/native/custom.ts";

function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), map };
}
const ROOT = "/schedule/project";
const OTHER = "/schedule/other";
const NOW = new Date("2026-11-05T02:00:10");
const ENV = { features: null, coreFeatures: null, hasRepo: true, localHost: true, mode: "local" };

/** A saved project state with the master switch on and the given tasks armed for the top of every hour. */
function armed(root, s, ids, { cron = "0 * * * *" } = {}) {
  const st = defaultTaskState();
  st.masterEnabled = true;
  for (const id of ids) st.configs[id] = { ...st.configs[id], enabled: true, scheduleActive: true, cron };
  saveTaskState(root, st, s);
  return st;
}

function deps(s, over = {}) {
  const records = [];
  const runs = [];
  return {
    storage: s,
    now: () => NOW,
    hasRepo: () => true,
    writeRunLive: () => false,
    acquire: () => true,
    release: () => {},
    run: async (item) => { runs.push(item); return { ok: true, summary: "done" }; },
    record: (r) => records.push(r),
    memory: new Set(),
    ...over,
    records,
    runs,
  };
}

/** The real registry runner, with a core that answers every task route with the given error code. */
function registryRun(requests, fail) {
  const core = { request: async (path, init) => { requests.push({ path, init }); if (fail) throw Object.assign(new Error(fail.message), { code: fail.code }); return { ok: true, summary: "ok", output: "" }; } };
  return async (item) => {
    const r = await runTask(item.id, { projectRoot: ROOT, core, host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null, changedPaths: async () => [], revert: async () => {}, actions: {} });
    return { ok: r.ok, code: r.code, summary: r.summary };
  };
}

test("the scheduler never returns a task with no desktop schedule, whatever is stored", () => {
  const s = storage();
  const st = armed(ROOT, s, ["issues.implement", "issues.from_notes", "review.merge"], { cron: "* * * * *" });
  assert.deepEqual(dueTasks(st, NOW, new Set(), ENV, ROOT), []);
});

test("an armed task fires once per minute and only while the master switch is on", () => {
  const s = storage();
  const st = armed(ROOT, s, ["review.code"]);
  const fired = new Set();
  assert.deepEqual(dueTasks(st, NOW, fired, ENV, ROOT), ["review.code"]);
  assert.deepEqual(dueTasks(st, NOW, fired, ENV, ROOT), [], "same minute: already fired");
  assert.deepEqual(dueTasks({ ...st, masterEnabled: false }, new Date("2026-11-05T03:00:10"), new Set(), ENV, ROOT), []);
});

test("an app-scoped task fires once, not once per open project", () => {
  const s = storage();
  const a = armed(ROOT, s, ["sources.update"]);
  const b = armed(OTHER, s, ["sources.update"]);
  const fired = new Set();
  assert.deepEqual(dueTasks(a, NOW, fired, ENV, ROOT), ["sources.update"]);
  assert.deepEqual(dueTasks(b, NOW, fired, ENV, OTHER), [], "the second project does not run it again this minute");
});

test("a capped member's scheduled run makes no engine call and is recorded as skipped with the reason", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const requests = [];
  const d = deps(s, { run: registryRun(requests, { code: "USD_CAP", message: "Monthly USD cap reached" }) });
  assert.equal(await runDueScheduled(ROOT, d), 1);
  assert.deepEqual(requests.map((r) => r.path), ["/kb/tasks/review.code/run"], "the core refused before the agent ran");
  assert.equal(d.records.length, 1);
  assert.equal(d.records[0].status, "skipped");
  assert.equal(d.records[0].summary, "Monthly USD cap reached");
});

test("a scheduled run is skipped while a write run is live in the same project", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const d = deps(s, { writeRunLive: (root) => root === ROOT });
  await runDueScheduled(ROOT, d);
  assert.equal(d.runs.length, 0);
  assert.equal(d.records[0].status, "skipped");
  assert.match(d.records[0].summary, /writing in this project/);
});

test("due tasks run one at a time", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code", "review.doc"]);
  let inFlight = 0;
  let peak = 0;
  const d = deps(s, { run: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { ok: true, summary: "done" }; } });
  assert.equal(await runDueScheduled(ROOT, d), 2);
  assert.equal(peak, 1);
});

test("a busy Auto Task slot starts nothing and marks nothing fired", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const busy = deps(s, { acquire: () => false });
  assert.equal(await runDueScheduled(ROOT, busy), 0);
  const free = deps(s, { memory: busy.memory });
  assert.equal(await runDueScheduled(ROOT, free), 1, "the same minute still runs once the slot is free");
});

test("a custom task goes through the same queue and fires once per minute", async () => {
  const s = storage();
  armed(ROOT, s, []);
  const task = createCustomTask(ROOT, { name: "Nightly", prompt: "look", mode: "review", cron: "0 * * * *" }, "custom-queue");
  saveCustomTasks([task], ROOT, s);
  const d = deps(s);
  assert.equal(await runDueScheduled(ROOT, d), 1);
  assert.equal(d.runs[0].kind, "custom");
  assert.equal(d.runs[0].task.id, task.id);
  assert.equal(await runDueScheduled(ROOT, d), 0);
  assert.equal(loadCustomTasks(ROOT, s).length, 1, "the custom store is only read here");
});

test("stopping the scheduler stops the queue between tasks", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code", "review.doc"]);
  let stop = false;
  const d = deps(s, { shouldStop: () => stop, run: async () => { stop = true; return { ok: true, summary: "done" }; } });
  assert.equal(await runDueScheduled(ROOT, d), 1);
});

test("a fired mark that cannot be saved still stops a second run in the same minute", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const set = s.setItem;
  s.setItem = (k, v) => { if (k === "llmide.tasks.v2.fired") throw new Error("quota"); return set(k, v); };
  const memory = new Set();
  assert.equal(await runDueScheduled(ROOT, deps(s, { memory })), 1);
  assert.equal(await runDueScheduled(ROOT, deps(s, { memory })), 0);
});

test("the timer ticks until it is stopped", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const d = deps(s);
  const stop = startTaskScheduler(ROOT, d, 5);
  await new Promise((r) => setTimeout(r, 30));
  stop();
  assert.equal(d.runs.length, 1, "every tick in the same minute after the first is a no-op");
  const count = d.runs.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.runs.length, count);
});
