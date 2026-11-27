import { test } from "node:test";
import assert from "node:assert/strict";
import { markPageRun, pageRunStarting, SCHEDULE_PASS_MS, loadSchedule, saveSchedule, scheduleKey, schedulePass, startLoopSchedule } from "../native/loop-schedule.ts";
import { initialProjectStore } from "../native/templates.ts";

const base = initialProjectStore("npm test");
const mk = (defaultKey) => structuredClone(base.loops.find((l) => l.defaultKey === defaultKey));
const testLoop = Object.assign(mk("test"), { runsOnSchedule: true });
const factory = Object.assign(mk("factory"), { runsOnSchedule: true });
const oneItem = Object.assign(mk("test"), { id: "one", name: "One", runsOnSchedule: true });
oneItem.config.workMode = "one";

function world(loops, over = {}) {
  const store = new Map();
  const w = { started: [], said: [], notified: [], root: "/p", active: false, has: false, intervals: [], projectListeners: new Set(), store };
  w.deps = {
    now: () => new Date(2026, 10, 27, 2, 0, 5),
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    projectRoot: () => w.root,
    loadLoops: async () => ({ kind: "ok", store: { ...base, loops }, hash: "h" }),
    loopHasRun: () => w.has,
    runActive: () => w.active,
    start: (root, item) => w.started.push({ root, item }),
    tell: (m) => w.said.push(m),
    notify: (m) => w.notified.push(m),
    valid: () => true,
    matches: () => true,
    setInterval: (fn, ms) => { w.intervals.push({ fn, ms, cleared: false }); return w.intervals.length - 1; },
    clearInterval: (id) => { w.intervals[id].cleared = true; },
    onProjectChange: (fn) => { w.projectListeners.add(fn); return () => w.projectListeners.delete(fn); },
    ...over,
  };
  store.set(scheduleKey("/p"), JSON.stringify({ cron: "0 2 * * *", last: "" }));
  return w;
}

test("a due schedule starts each marked loop through start with scheduled:true, and records the minute", async () => {
  const w = world([testLoop]);
  await schedulePass(w.deps);
  assert.equal(w.started.length, 1);
  assert.equal(w.started[0].root, "/p");
  assert.equal(w.started[0].item.key, `loop:${testLoop.id}`);
  assert.deepEqual(w.started[0].item.loop, { loopId: testLoop.id, scheduled: true });
  assert.equal(JSON.parse(w.store.get(scheduleKey("/p"))).last, "2026-11-27-2-0");
  await schedulePass(w.deps);
  assert.equal(w.started.length, 1, "the same minute does not fire twice");
});

test("Factory and one-item loops are skipped with a notice; loops without Run on schedule are not started", async () => {
  const off = Object.assign(mk("test"), { id: "off", runsOnSchedule: false });
  const w = world([factory, oneItem, off, testLoop]);
  await schedulePass(w.deps);
  assert.deepEqual(w.started.map((s) => s.item.key), [`loop:${testLoop.id}`]);
  assert.ok(w.said.some((m) => /Factory loop/.test(m)));
  assert.ok(w.said.some((m) => /one item you name; the schedule skipped it/.test(m)));
});

test("nothing marked, a run already active, and a loop that already has a run each say so", async () => {
  let w = world([Object.assign(mk("test"), { runsOnSchedule: false })]);
  await schedulePass(w.deps);
  assert.deepEqual(w.said, ["The schedule fired, but no loop is marked Run on schedule."]);
  w = world([testLoop]); w.active = true;
  await schedulePass(w.deps);
  assert.equal(w.started.length, 0);
  assert.match(w.said[0], /while a run is active/);
  w = world([testLoop]); w.has = true;
  await schedulePass(w.deps);
  assert.equal(w.started.length, 0);
  assert.match(w.said.at(-1), /already has a run/);
});

test("no project open: no pass writes or fires; a project closed while loop.json loads fires nothing", async () => {
  let w = world([testLoop]); w.root = null;
  await schedulePass(w.deps);
  assert.equal(w.started.length, 0);
  assert.equal(JSON.parse(w.store.get(scheduleKey("/p"))).last, "");
  w = world([testLoop]);
  w.deps.loadLoops = async () => { w.root = null; return { kind: "ok", store: { ...base, loops: [testLoop] }, hash: "h" }; };
  await schedulePass(w.deps);
  assert.equal(w.started.length, 0);
});

test("the stored schedule keeps its key and format: a minute already fired does not refire, a cleared cron stays cleared", async () => {
  const w = world([testLoop]);
  w.store.set(scheduleKey("/p"), JSON.stringify({ cron: "0 2 * * *", last: "2026-11-27-2-0" }));
  await schedulePass(w.deps);
  assert.equal(w.started.length, 0);
  assert.equal(scheduleKey("/p"), "llmide.loopSchedule.v1./p");
  saveSchedule(w.deps.storage, "/p", " 0 2 * * * ");
  assert.deepEqual(loadSchedule(w.deps.storage, "/p"), { cron: "0 2 * * *", last: "2026-11-27-2-0" });
  saveSchedule(w.deps.storage, "/p", "0 3 * * *");
  assert.deepEqual(loadSchedule(w.deps.storage, "/p"), { cron: "0 3 * * *", last: "" });
  saveSchedule(w.deps.storage, "/p", "");
  await schedulePass(w.deps);
  assert.equal(w.started.length, 0);
});

test("one timer per app: starting again replaces the first; a project change runs a pass for the new project", async () => {
  const w = world([testLoop]);
  const stop1 = startLoopSchedule(w.deps);
  assert.equal(w.intervals[0].ms, SCHEDULE_PASS_MS);
  const stop2 = startLoopSchedule(w.deps);
  assert.equal(w.intervals[0].cleared, true, "the first timer was cleared");
  assert.equal(w.intervals[1].cleared, false);
  assert.equal(w.projectListeners.size, 1);
  await new Promise((r) => setImmediate(r));
  const before = w.started.length;
  w.root = "/q";
  w.store.set(scheduleKey("/q"), JSON.stringify({ cron: "0 2 * * *", last: "" }));
  for (const fn of w.projectListeners) fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.started.length, before + 1);
  assert.equal(w.started.at(-1).root, "/q");
  stop1();
  assert.equal(w.intervals[1].cleared, false, "a stale stop does not clear the current timer");
  stop2();
  assert.equal(w.intervals[1].cleared, true);
  assert.equal(w.projectListeners.size, 0);
});

test("a skipped pass is also notified for the closed page; an unreadable loop file is reported, not swallowed", async () => {
  let w = world([testLoop]); w.active = true;
  await schedulePass(w.deps);
  assert.deepEqual(w.notified, w.said);
  assert.match(w.notified[0], /while a run is active/);
  w = world([testLoop]);
  w.deps.loadLoops = async () => { throw new Error("EIO"); };
  await schedulePass(w.deps);
  assert.match(w.notified[0], /loop file could not be read: EIO/);
  w = world([testLoop]);
  w.deps.loadLoops = async () => ({ kind: "corrupt", message: "bad json" });
  await schedulePass(w.deps);
  assert.match(w.notified[0], /could not be read: bad json/);
  assert.equal(w.started.length, 0);
});

test("a Factory run the page is starting makes the schedule's runActive true until released", async () => {
  const { realDeps } = await import("../native/loop-schedule-wiring.ts").catch(() => ({ realDeps: null }));
  const release = markPageRun("/p");
  const release2 = markPageRun("/p");
  assert.equal(pageRunStarting("/p"), true);
  assert.equal(pageRunStarting("/other"), false);
  release();
  release();
  assert.equal(pageRunStarting("/p"), true, "release is idempotent; the second mark still holds");
  release2();
  assert.equal(pageRunStarting("/p"), false);
  const { readFileSync } = await import("node:fs");
  const wiring = readFileSync(new URL("../native/loop-schedule-wiring.ts", import.meta.url), "utf8");
  assert.match(wiring, /runActive: \(root\) => pageRunStarting\(root\) \|\|/);
  const page = readFileSync(new URL("../native/NativeLoopScreen.tsx", import.meta.url), "utf8");
  assert.match(page, /markPageRun\(projectRoot\)[\s\S]*releasePageRun\(\);\s*startGateRef\.current\.release\(\)/);
  assert.ok(realDeps === null || typeof realDeps === "function");
});
