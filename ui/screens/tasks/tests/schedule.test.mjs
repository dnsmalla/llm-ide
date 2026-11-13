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

test("a slot due while the lock is taken waits and runs once as soon as the lock is free", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const waiting = [];
  // 02:00:10, a short manual run holds the lock: nothing runs, nothing is recorded, the slot waits.
  const busy = deps(s, { acquire: () => false, waiting });
  assert.equal(await runDueScheduled(ROOT, busy), 0);
  assert.equal(busy.runs.length, 0);
  assert.equal(busy.records.length, 0, "not given up yet");
  assert.equal(waiting.length, 1);
  // 02:00:40, the next pass, the lock is free: the 02:00 task runs (it used to be lost for the whole day).
  const free = deps(s, { now: () => new Date("2026-11-05T02:00:40"), memory: busy.memory, waiting });
  assert.equal(await runDueScheduled(ROOT, free), 1);
  assert.deepEqual(free.runs, [{ kind: "task", id: "review.code" }]);
  assert.equal(free.records[0].status, "ok");
  assert.equal(waiting.length, 0);
  // And never a second time, in that minute or later.
  const later = deps(s, { now: () => new Date("2026-11-05T02:00:55"), memory: busy.memory, waiting });
  assert.equal(await runDueScheduled(ROOT, later), 0);
  assert.equal(later.runs.length, 0);
});

test("a slot that waits past the catch-up window is recorded once as skipped (busy) and never runs late", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  const waiting = [];
  const busy = deps(s, { acquire: () => false, waiting });
  await runDueScheduled(ROOT, busy);
  // Still taken five minutes later: keeps waiting, still silent.
  const mid = deps(s, { acquire: () => false, now: () => new Date("2026-11-05T02:05:10"), memory: busy.memory, waiting });
  assert.equal(await runDueScheduled(ROOT, mid), 0);
  assert.equal(mid.records.length, 0);
  assert.equal(waiting.length, 1);
  // Past the window, with the lock free again: it is given up with a record, not started eleven minutes late.
  const late = deps(s, { now: () => new Date("2026-11-05T02:11:10"), memory: busy.memory, waiting });
  assert.equal(await runDueScheduled(ROOT, late), 1);
  assert.equal(late.runs.length, 0);
  assert.equal(late.records.length, 1);
  assert.equal(late.records[0].status, "skipped");
  assert.match(late.records[0].summary, /busy/);
  assert.deepEqual(late.records[0].item, { kind: "task", id: "review.code" });
  assert.equal(late.records[0].at, new Date("2026-11-05T02:00:10").toISOString(), "recorded at the time it was due");
  assert.equal(waiting.length, 0);
});

test("a waiting slot belongs to its project: another project's pass neither runs nor drops it", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"]);
  armed(OTHER, s, []);
  const waiting = [];
  const busy = deps(s, { acquire: () => false, waiting });
  await runDueScheduled(ROOT, busy);
  const other = deps(s, { now: () => new Date("2026-11-05T02:00:40"), memory: busy.memory, waiting });
  assert.equal(await runDueScheduled(OTHER, other), 0);
  assert.equal(other.runs.length, 0);
  assert.equal(waiting.length, 1);
});

test("nothing due and a busy lock records nothing", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code"], { cron: "5 * * * *" });
  const busy = deps(s, { acquire: () => false });
  assert.equal(await runDueScheduled(ROOT, busy), 0);
  assert.equal(busy.records.length, 0);
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

test("a task the user stopped is recorded as skipped, not failed, and the pass starts nothing after it", async () => {
  const s = storage();
  armed(ROOT, s, ["review.code", "review.security"]);
  let stopped = false;
  const d = deps(s, { run: async (item) => { d.runs.push(item); stopped = true; return { ok: false, code: "STOPPED", summary: "Stopped by the user." }; }, shouldStop: () => stopped });
  const n = await runDueScheduled(ROOT, d);
  assert.equal(d.runs.length, 1, "the second due task of the pass does not start");
  assert.equal(n, 1);
  assert.equal(d.records[0].status, "skipped");
});
