import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createTasksController, parseStoredRuns, MAX_RECENT_RUNS, MAX_STORED_OUTPUT, POLL_MS } from "../src/tasks/controller.ts";
import { createLoopController, MAX_LOOP_ISSUES } from "../src/loop/controller.ts";
import { mapFeatureError } from "../src/tasks/errors.ts";
import { loadUi, h, html } from "./helpers.mjs";

let UI;
before(async () => { UI = await loadUi(); });

const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), m }; };
const err = (code, message = code) => Object.assign(new Error(message), { code });
function fakeLink(results = {}) {
  const calls = []; let n = 0;
  return {
    calls, capabilities: new Set(["read", "compose"]),
    send(command, payload) {
      calls.push({ command, payload });
      const r = results[command];
      const done = (async () => { const v = typeof r === "function" ? r(payload, calls.filter((c) => c.command === command).length) : r ?? {}; if (v instanceof Error) throw v; return v; })();
      done.catch(() => {});
      return { id: `c-${++n}`, done };
    },
    onEvent: () => () => {}, onResync: () => () => {}, onState: () => () => {},
  };
}
const fakeTimers = () => {
  const t = []; 
  return { t, setTimer: (fn, ms) => { const h = { fn, ms, off: false }; t.push(h); return h; }, clearTimer: (h) => { h.off = true; },
    live: () => t.filter((x) => !x.off), async fire() { const x = t.filter((y) => !y.off).pop(); x.off = true; x.fn(); await new Promise((r) => setTimeout(r, 0)); } };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const TASK = { id: "triage", label: "Triage", group: "Issues", description: "d", scope: "project", available: true };

test("tasks.list payload and state", async () => {
  const link = fakeLink({ "tasks.list": { tasks: [TASK] } });
  const c = createTasksController(link, { storage: null, desktopKey: "d" });
  await c.load();
  assert.deepEqual(link.calls[0], { command: "tasks.list", payload: {} });
  assert.equal(c.getState().tasks.length, 1);
  assert.equal(c.getState().loaded, true);
});

test("tasks.run payload: project only for project scope, empty args dropped", async () => {
  const link = fakeLink({ "tasks.run": (_p, n) => ({ runId: `r${n}` }), "tasks.status": { status: "running" } });
  const c = createTasksController(link, { storage: null, desktopKey: "d", ...fakeTimers() });
  assert.equal(await c.run(TASK, "p-1", { a: "x", b: "  ", c: "" }), true);
  assert.deepEqual(link.calls[0], { command: "tasks.run", payload: { taskId: "triage", projectId: "p-1", args: { a: "x" } } });
  await c.run({ ...TASK, id: "g", scope: "global" }, "p-1", {});
  assert.deepEqual(link.calls[1].payload, { taskId: "g" });
  assert.equal(c.getState().runs.length, 2);
});

test("polling: starts when a run starts, stops when it completes, and when inactive", async () => {
  const tm = fakeTimers();
  let status = "running";
  const link = fakeLink({ "tasks.run": { runId: "r1" }, "tasks.status": () => ({ status, output: "hi", summary: "s" }) });
  const c = createTasksController(link, { storage: null, desktopKey: "d", ...tm });
  c.setActive(true);
  await c.run(TASK, "p", {});
  assert.equal(tm.live().length, 1);
  assert.equal(tm.live()[0].ms, POLL_MS);
  await tm.fire();
  assert.deepEqual(link.calls.at(-1), { command: "tasks.status", payload: { runId: "r1" } });
  assert.equal(tm.live().length, 1, "still running: next poll scheduled");
  status = "completed";
  await tm.fire();
  assert.equal(c.getState().runs[0].status, "completed");
  assert.equal(c.getState().runs[0].output, "hi");
  assert.equal(tm.live().length, 0, "nothing running: polling stops");
  // hidden page stops the timer
  status = "running";
  await c.run(TASK, "p", {});
  assert.equal(tm.live().length, 1);
  c.setActive(false);
  assert.equal(tm.live().length, 0);
});

test("cancel sends tasks.cancel and marks the run cancelled", async () => {
  const link = fakeLink({ "tasks.run": { runId: "r1" }, "tasks.cancel": { cancelled: true } });
  const c = createTasksController(link, { storage: null, desktopKey: "d", ...fakeTimers() });
  await c.run(TASK, "p", {});
  await c.cancel("r1");
  assert.deepEqual(link.calls.at(-1), { command: "tasks.cancel", payload: { runId: "r1" } });
  assert.equal(c.getState().runs[0].status, "cancelled");
});

test("recent runs persist per desktop, bounded, and survive bad storage", async () => {
  const st = memory();
  const link = fakeLink({ "tasks.run": (_p, n) => ({ runId: `r${n}` }) });
  const c = createTasksController(link, { storage: st, desktopKey: "A", ...fakeTimers() });
  for (let i = 0; i < MAX_RECENT_RUNS + 5; i++) await c.run(TASK, "p", {});
  assert.equal(c.getState().runs.length, MAX_RECENT_RUNS);
  assert.equal(JSON.parse(st.getItem("llmide.web.taskRuns.v1:A")).length, MAX_RECENT_RUNS);
  const again = createTasksController(link, { storage: st, desktopKey: "A" });
  assert.equal(again.getState().runs.length, MAX_RECENT_RUNS);
  assert.equal(createTasksController(link, { storage: st, desktopKey: "B" }).getState().runs.length, 0);
  assert.deepEqual(parseStoredRuns("not json"), []);
  assert.deepEqual(parseStoredRuns(JSON.stringify([{ runId: "bad id!", status: "running" }, { runId: "ok", status: "weird" }])), []);
  const long = parseStoredRuns(JSON.stringify([{ runId: "ok", status: "completed", output: "x".repeat(MAX_STORED_OUTPUT * 2) }]));
  assert.equal(long[0].output.length, MAX_STORED_OUTPUT);
  const throwing = { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); }, removeItem() {} };
  const t = createTasksController(link, { storage: throwing, desktopKey: "A", ...fakeTimers() });
  assert.equal(await t.run(TASK, "p", {}), true);
});

test("error mapping", () => {
  assert.equal(mapFeatureError(err("unknown_command"), "Auto Tasks").kind, "unavailable");
  assert.match(mapFeatureError(err("capability_unavailable"), "Loop").message, /does not offer Loop/);
  assert.equal(mapFeatureError(err("denied", "No."), "Loop").message, "No.");
  assert.equal(mapFeatureError(err("rate_limited"), "Loop").kind, "busy");
  assert.equal(mapFeatureError(new Error("boom"), "Loop").message, "boom");
});

test("tasks.list failure becomes a friendly error, run failure keeps the list", async () => {
  const c = createTasksController(fakeLink({ "tasks.list": err("unknown_command") }), { storage: null, desktopKey: "d" });
  await c.load();
  assert.equal(c.getState().error.kind, "unavailable");
  const c2 = createTasksController(fakeLink({ "tasks.run": err("denied", "Nope") }), { storage: null, desktopKey: "d" });
  assert.equal(await c2.run(TASK, "p", {}), false);
  assert.equal(c2.getState().actionError.kind, "denied");
});

// ---- Loop ----
const RUN = (id, state) => ({ id, state, createdAt: "2026-11-12T00:00:00Z", issueCount: 1 });

test("loop.list/history payloads on project select", async () => {
  const link = fakeLink({ "loop.list": { runs: [RUN("run-00001", "succeeded")] }, "loop.history": { runs: [] } });
  const c = createLoopController(link, fakeTimers());
  await c.setProject("p-1");
  assert.deepEqual(link.calls.map((x) => x.command).sort(), ["loop.history", "loop.list"]);
  assert.deepEqual(link.calls.find((x) => x.command === "loop.list").payload, { projectId: "p-1" });
  assert.deepEqual(link.calls.find((x) => x.command === "loop.history").payload, { projectId: "p-1" });
  assert.equal(c.getState().runs.length, 1);
});

test("loop.issues, loop.start and loop.cancel payloads; start enforces 1..20", async () => {
  const link = fakeLink({ "loop.list": { runs: [] }, "loop.history": { runs: [] }, "loop.issues": { issues: [{ id: "i1", title: "t" }] }, "loop.start": { id: "run-00001", state: "awaiting_approval" }, "loop.cancel": { cancelled: true } });
  const c = createLoopController(link, fakeTimers());
  await c.setProject("p-1");
  await c.loadIssues();
  assert.deepEqual(link.calls.find((x) => x.command === "loop.issues").payload, { projectId: "p-1", limit: 100 });
  assert.equal(await c.start([]), false);
  assert.equal(await c.start(Array.from({ length: MAX_LOOP_ISSUES + 1 }, (_, i) => `i${i}`)), false);
  assert.equal(await c.start(["i1"]), true);
  assert.deepEqual(link.calls.find((x) => x.command === "loop.start").payload, { projectId: "p-1", issueIds: ["i1"] });
  assert.deepEqual(c.getState().lastStarted, { id: "run-00001", state: "awaiting_approval" });
  await c.cancel("run-00001");
  assert.deepEqual(link.calls.find((x) => x.command === "loop.cancel").payload, { id: "run-00001" });
});

test("loop polling runs only while a run is active and the section is active", async () => {
  const tm = fakeTimers();
  let state = "running";
  const link = fakeLink({ "loop.list": () => ({ runs: [RUN("run-00001", state)] }), "loop.history": { runs: [] } });
  const c = createLoopController(link, tm);
  c.setActive(true);
  await c.setProject("p-1");
  assert.equal(tm.live().length, 1);
  await tm.fire();
  assert.equal(tm.live().length, 1);
  state = "succeeded";
  await tm.fire();
  assert.equal(tm.live().length, 0, "final state: polling stops");
  state = "queued";
  await c.refresh();
  assert.equal(tm.live().length, 1);
  c.setActive(false);
  assert.equal(tm.live().length, 0);
  state = "running"; c.setActive(true); await tick();
  c.dispose();
  assert.equal(tm.live().length, 0);
});

test("loop errors: list unavailable, history failure is not fatal", async () => {
  const c = createLoopController(fakeLink({ "loop.list": err("capability_unavailable"), "loop.history": err("denied", "no") }), fakeTimers());
  await c.setProject("p-1");
  assert.equal(c.getState().error.kind, "unavailable");
  assert.equal(c.getState().historyError.kind, "denied");
  const d = createLoopController(fakeLink({ "loop.list": { runs: [] }, "loop.history": err("denied", "no"), "loop.start": err("denied", "Not allowed") }), fakeTimers());
  await d.setProject("p-1");
  assert.equal(d.getState().error, null);
  assert.equal(await d.start(["i1"]), false);
  assert.equal(d.getState().actionError.message, "Not allowed");
});

test("sections register and hide without the capability", () => {
  const tasks = UI.getSections().find((s) => s.id === "tasks");
  const loop = UI.getSections().find((s) => s.id === "loop");
  assert.ok(tasks && loop);
  assert.deepEqual(tasks.requires, ["read"]);
  assert.equal(UI.sectionVisible(tasks, { capabilities: new Set(["chat"]), hub: false }), false);
  assert.equal(UI.sectionVisible(loop, { capabilities: new Set(["read"]), hub: false }), true);
});

// ---- render ----
const Plain = ({ title, children, footer }) => h("div", { role: "dialog" }, h("h2", null, title), children, footer);
const props = (state, o = {}) => ({ sheetShell: Plain, state, projectName: "Atlas", canRun: true, canStart: true, onRefresh() {}, onRun() {}, onCancel() {}, onClear() {}, onDismiss() {}, onDismissStarted() {}, onOpenIssues() {}, onStart() {}, ...o });

test("tasks render: groups, unavailable, runs, output, cancel", () => {
  const out = html(h(UI.TasksView, props(UI.TASKS_FIXTURE)));
  for (const s of ["Issues", "Code", "Maintenance", "Triage new issues", UI.NOT_AVAILABLE, "Recent runs", "Running", "Completed", "Failed", "The tracker token has expired.", "fetched 12 issues", "Cancel"]) assert.ok(out.includes(s), s);
  assert.match(out, /aria-label="Run Re-index the repository"[^>]*disabled/);
});
test("tasks render: empty state, error banner, run sheet args", () => {
  const empty = html(h(UI.TasksView, props(UI.TASKS_EMPTY_FIXTURE)));
  assert.ok(empty.includes(UI.TASKS_EMPTY)); assert.ok(empty.includes("Refresh"));
  const bad = html(h(UI.TasksView, props({ ...UI.TASKS_EMPTY_FIXTURE, error: { kind: "unavailable", message: "This desktop does not offer Auto Tasks." } })));
  assert.ok(bad.includes("does not offer Auto Tasks"));
  const sheet = html(h(UI.TasksView, props(UI.TASKS_FIXTURE, { initialSheet: "triage" })));
  for (const s of ["Run on desktop", "label", "paths", "One per line, up to 5", "Project: Atlas"]) assert.ok(sheet.includes(s), s);
});
test("task arg validation and grouping", () => {
  assert.equal(UI.validateArg({ name: "a", type: "string", maxLength: 3 }, "abcd"), "At most 3 characters.");
  assert.equal(UI.validateArg({ name: "a", type: "string[]", maxItems: 2 }, "a\nb\nc"), "At most 2 items.");
  assert.equal(UI.validateArg({ name: "a", type: "string[]", maxItems: 2 }, "a\n\nb"), null);
  assert.deepEqual(UI.groupTasks([{ ...TASK, group: "" }]).map((g) => g.group), ["Other"]);
});
test("loop render: runs, ready to ship, approval, history, empty, issues sheet", () => {
  const out = html(h(UI.LoopView, props(UI.LOOP_FIXTURE)));
  for (const s of ["Awaiting approval", "approve on the desktop", "Implementing", "Ready to ship on the desktop", "tests_failed", "Start a run", "Desktop Loop history", "Nightly refactor"]) assert.ok(out.includes(s), s);
  assert.equal((out.match(/>Cancel</g) ?? []).length, 2, "cancel only on awaiting_approval and running");
  const empty = html(h(UI.LoopView, props(UI.LOOP_EMPTY_FIXTURE)));
  assert.ok(empty.includes("No runs from this browser yet"));
  const sheet = html(h(UI.LoopView, props(UI.LOOP_FIXTURE, { initialSheet: true })));
  for (const s of ["Pick issues", "Retry helper swallows the last error", "Start (0)", "atlas/api"]) assert.ok(sheet.includes(s), s);
  const noIssues = html(h(UI.LoopView, props({ ...UI.LOOP_EMPTY_FIXTURE }, { initialSheet: true })));
  assert.ok(noIssues.includes(UI.LOOP_NO_ISSUES));
  assert.ok(html(h(UI.LoopView, props({ ...UI.LOOP_EMPTY_FIXTURE, projectId: null }))).includes("Pick a project"));
});
