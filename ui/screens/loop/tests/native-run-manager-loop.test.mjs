import { test } from "node:test";
import assert from "node:assert/strict";
import * as rm from "../native/run-manager.ts";
import { pickDriver } from "../native/loop-drivers.ts";
import { initialProjectStore } from "../native/templates.ts";
import { runStatusCode } from "../native/runner.ts";
import { runTrigger } from "../native/history.ts";

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 40; i++) await tick(); }
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function memoryStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; }

const store = initialProjectStore("npm test");
const byKey = (key) => store.loops.find((l) => l.defaultKey === key);
const PASSED = { passed: true, iterationsUsed: 1, stages: [], iterations: [], failedStage: null, statusSummary: "passed after 1 iteration" };
const FAILED = { passed: false, iterationsUsed: 1, stages: [], iterations: [], failedStage: null, statusSummary: "failed" };

let world;
const endOf = () => world.events.filter((e) => e.type === "finished").at(-1);
function setup(over = {}, hostOver = {}) {
  world = { active: "/p", listeners: new Set(), incidents: [], calls: [], drivers: [], records: [], gates: [], approvals: 0, shipped: [], loops: [], events: [], stages: [], finishedInfo: [], status: { changedFiles: 0, localCommits: 0, pushed: false }, diffFiles: [] };
  let ids = 0;
  let seed = 1;
  rm.resetRunManagerForTests();
  rm.subscribeLoopRunEvents((e) => world.events.push(e));
  const driver = (kind) => (config, deps) => { world.drivers.push(kind); const g = deferred(); world.gates.push({ kind, deps, ...g }); return g.promise; };
  rm.configureRunManager({
    host: async (command, args) => {
      world.calls.push([command, args]);
      if (command === "loop_work_root") return "/p";
      if (command === "loop_worktree_list") return [];
      if (command === "loop_worktree_prepare") return { runId: args.runId, project: "/p", repo: "/p", worktree: `/p/system/loop-worktrees/${args.runId}`, branch: `loop/${args.runId}`, baseCommit: "abc1234def" };
      if (command === "loop_worktree_status") return world.status;
      if (command === "loop_worktree_diff") return { text: "", truncated: false, patchId: "c".repeat(64), files: world.diffFiles };
      if (command === "loop_changed_paths") return [];
      if (command === "loop_worktree_remove_if_empty") return true;
      return null;
    },
    core: { async request() { return {}; } },
    fsFor: () => ({
      read: async (path) => { if (path === "system/loop.json") return { status: "ok", text: JSON.stringify(store), hash: "h1" }; throw Object.assign(new Error("missing"), { code: "missing" }); },
      list: async () => [], create: async () => undefined, write: async () => ({ hash: "x" }), remove: async () => undefined,
    }),
    approve: async () => { world.approvals += 1; return "tok"; },
    createStageDeps: (_ctx, loop) => (world.loops.push(loop), { async runStage() { return { ok: true, output: "" }; }, async repair() { return { ok: true, output: "" }; }, halt: () => null, haltIsError: () => false }),
    runLoop: driver("plain"),
    appendRecord: async (_fs, entry, record) => { world.records.push({ entry, record }); },
    copyReadiness: async () => false,
    autoShip: async (e) => { world.shipped.push(e); return "Draft MR: https://example.test/mr/1"; },
    activeProject: () => world.active,
    subscribeProject: (l) => { world.listeners.add(l); return () => world.listeners.delete(l); },
    storage: memoryStorage(),
    onStage: (runId) => world.stages.push(runId),
    onRunFinished: (info) => world.finishedInfo.push(info),
    now: () => new Date("2026-11-09T10:00:00Z"),
    rand: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    newId: () => `e${++ids}`,
    loopRun: {
      approvalStatus: async () => ({ approved: false, pending: 1, expiresAtMs: null, token: null }),
      refreshApproval: async () => undefined,
      reportIncident: (m) => world.incidents.push(m),
      post: async () => ({ status: 404, body: {} }),
      readRepoConfig: () => ({ operations: { github: [], gitlab: [] }, saved: { github: [], gitlab: [] } }),
      drivers: { refactor: driver("refactor"), test: driver("test"), allPasses: driver("allPasses") },
      ...hostOver,
    },
    ...over,
  });
}
const start = (loop, request = {}) => rm.startRun("/p", rm.loopRunItem(loop, request), "full");
async function finish(index, outcome) { world.gates[index].resolve(outcome); await settle(); }

test("pickDriver: Refactoring and Test walk their plan, Everything repeats passes, the rest run plain", () => {
  const cfg = (l) => l.config;
  assert.equal(pickDriver(byKey("refactor"), cfg(byKey("refactor")), true, false), "refactor");
  assert.equal(pickDriver(byKey("refactor"), cfg(byKey("refactor")), true, true), "refactor");
  assert.equal(pickDriver(byKey("test"), cfg(byKey("test")), true, false), "test");
  assert.equal(pickDriver(byKey("test"), cfg(byKey("test")), true, true), "plain");
  assert.equal(pickDriver(byKey("plan"), cfg(byKey("plan")), true, false), "allPasses");
  assert.equal(pickDriver(byKey("plan"), cfg(byKey("plan")), false, false), "plain");
  assert.equal(pickDriver(byKey("refactor"), cfg(byKey("refactor")), false, false), "plain");
  assert.equal(pickDriver(byKey("plan"), { ...cfg(byKey("plan")), maxPassesPerRun: 1 }, true, false), "plain");
});

test("a Test loop runs through the test-steps driver and writes the Loop page's record", async () => {
  setup();
  const loop = byKey("test");
  start(loop);
  await settle();
  assert.deepEqual(world.drivers, ["test"]);
  assert.equal(world.calls.filter(([c]) => c === "loop_worktree_prepare").length, 1);
  assert.equal(rm.liveRuns()[0].state, "running");
  await finish(0, PASSED);
  assert.equal(world.records.length, 1);
  const { entry, record } = world.records[0];
  assert.equal(entry.loopId, loop.id);
  assert.equal(entry.trigger, "manual");
  assert.equal(entry.statusCode, runStatusCode(PASSED));
  assert.match(entry.statusSummary, /No changes\./);
  assert.match(record.worktree.runId, /^test-[0-9a-f]{8}$/);
  assert.equal(record.workItem, null);
  assert.deepEqual(rm.liveRuns(), []);
});

test("a Refactoring loop runs through the batch driver, a Regression loop (no worktree) plain", async () => {
  setup();
  start(byKey("refactor"));
  await settle();
  assert.deepEqual(world.drivers, ["refactor"]);
  await finish(0, FAILED);
  start(byKey("regression"));
  await settle();
  assert.deepEqual(world.drivers, ["refactor", "plain"]);
  assert.equal(world.calls.filter(([c]) => c === "loop_worktree_prepare").length, 1);
  await finish(1, PASSED);
  assert.equal(world.records.length, 2);
});

test("a task named for the run makes it one plain pass", async () => {
  setup();
  start(byKey("test"), { command: "add a test for parse()" });
  await settle();
  assert.deepEqual(world.drivers, ["plain"]);
  await finish(0, PASSED);
});

test("a passed run with changes ships through autoShip; a leftover-file worktree holds it for review", async () => {
  setup();
  world.diffFiles = ["src/a.ts"];
  start(byKey("test"));
  await settle();
  await finish(0, PASSED);
  assert.equal(world.shipped.length, 1);
  assert.equal(world.shipped[0].processName, "Test");
  assert.equal(world.records[0].entry.statusCode, runStatusCode(PASSED));

  setup();
  world.diffFiles = ["src/a.ts"];
  world.status = { changedFiles: 2, localCommits: 0, pushed: false };
  start(byKey("test"));
  await settle();
  await finish(0, PASSED);
  assert.equal(world.shipped.length, 0);
  assert.equal(world.records[0].entry.statusCode, "awaiting_review");
  assert.equal(world.records[0].record.awaiting.held, "success");
});

test("a second run of the same loop is refused while one is live; a finished one frees the loop", async () => {
  setup();
  const first = start(byKey("test"));
  const second = start(byKey("test"), { command: "other task" });
  assert.equal(second, first);
  assert.match(rm.takeRunNotice() ?? "", /already has a run/);
  assert.equal(rm.liveRuns().length, 1);
  await settle();
  await finish(0, PASSED);
  const again = start(byKey("test"));
  assert.notEqual(again, first);
  await settle();
  await finish(1, PASSED);
});

test("a refused approval ends the run without a record or a worktree", async () => {
  setup({ approve: async () => null });
  start(byKey("test"));
  await settle();
  assert.equal(world.records.length, 0);
  assert.equal(world.calls.filter(([c]) => c === "loop_worktree_prepare").length, 0);
  assert.match(endOf().notice ?? "", /not approved/);
  assert.equal(endOf().refused, true);
  assert.equal(rm.takeRunNotice(), null, "a loop's refusal is not the Factory board's notice");
  assert.deepEqual(rm.liveRuns(), []);
});

test("a scheduled run needs a standing grant and never opens the approval dialog", async () => {
  setup();
  start(byKey("test"), { scheduled: true });
  await settle();
  assert.equal(world.approvals, 0);
  assert.match(endOf().notice ?? "", /needs a native host approval/);
  assert.equal(world.records.length, 0);

  setup({}, { approvalStatus: async () => ({ approved: true, pending: 0, expiresAtMs: null, token: "grant" }) });
  start(byKey("test"), { scheduled: true });
  await settle();
  assert.equal(world.approvals, 0);
  assert.deepEqual(world.drivers, ["test"]);
  await finish(0, PASSED);
  assert.equal(world.records[0].entry.trigger, runTrigger(true));
});

test("a board input path overrides the loop for this run only", async () => {
  setup();
  start(byKey("test"), { inputPath: "src/app" });
  await settle();
  assert.equal(world.loops[0].inputPath, "src/app");
  assert.notEqual(byKey("test").inputPath, "src/app");
  await finish(0, PASSED);
});

test("Stop cancels through loop_cancel with the worktree id and the run still ends with a record", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  rm.cancelRun(runId);
  const cancel = world.calls.find(([c]) => c === "loop_cancel");
  assert.match(cancel[1].runId, /^test-[0-9a-f]{8}$/);
  assert.equal(world.gates[0].deps.isCancelled(), true);
  await finish(0, { ...FAILED, cancelled: true, statusSummary: "cancelled" });
  assert.equal(world.records.length, 1);
  assert.deepEqual(rm.liveRuns(), []);
});

test("a queued loop run is cancelled without touching the host", async () => {
  setup();
  rm.setConcurrency(1);
  start(byKey("test"));
  const queued = start(byKey("plan"));
  assert.equal(rm.liveRuns().find((r) => r.runId === queued).state, "queued");
  rm.cancelRun(queued);
  assert.equal(world.calls.some(([c]) => c === "loop_cancel"), false);
  assert.equal(rm.liveRuns().length, 1);
  await settle();
  await finish(0, PASSED);
});

test("the Factory loop is refused here: it has its own board", async () => {
  setup();
  start(byKey("factory"));
  await settle();
  assert.match(endOf().notice ?? "", /Factory board/);
  assert.equal(world.records.length, 0);
});

async function switchProject(root) { world.active = root; for (const l of [...world.listeners]) l(); await settle(); }
const stateOf = (id) => rm.liveRuns().find((r) => r.runId === id)?.state;

test("two different loops of one project run one after the other, in start order; a Factory run is not held up", async () => {
  setup({ loadFactoryLoop: async () => byKey("factory") });
  const a = start(byKey("test"));
  const b = start(byKey("plan"));
  const factory = rm.startRun("/p", { key: "issue:1", source: "issue", id: "1", title: "Issue 1", body: "", repo: "", provider: null }, "full");
  await settle();
  assert.equal(rm.loopRunActive("/p"), true);
  assert.equal(stateOf(a), "running");
  assert.equal(stateOf(b), "queued");
  assert.equal(stateOf(factory), "running");
  assert.deepEqual(world.drivers.filter((k) => k !== "plain"), ["test"]);
  await finish(world.gates.findIndex((g) => g.kind === "test"), PASSED);
  assert.equal(stateOf(b), "running");
  assert.deepEqual(world.drivers.filter((k) => k !== "plain"), ["test", "allPasses"]);
  await finish(world.gates.findIndex((g) => g.kind === "allPasses"), PASSED);
  assert.equal(rm.loopRunActive("/p"), false);
});

test("the loop-run lock is released by a cancel and by a run that throws", async () => {
  setup();
  const a = start(byKey("test"));
  const b = start(byKey("plan"));
  await settle();
  rm.cancelRun(a);
  await finish(0, { ...FAILED, cancelled: true, statusSummary: "cancelled" });
  assert.equal(stateOf(b), "running");
  await finish(1, PASSED);

  setup({ createStageDeps: () => { throw new Error("boom"); } });
  const c = start(byKey("test"));
  const d = start(byKey("plan"));
  await settle();
  assert.deepEqual(world.incidents, ["boom", "boom"]);
  assert.equal(rm.loopRunActive("/p"), false);
  assert.equal(stateOf(c), undefined);
  assert.equal(stateOf(d), undefined);
});

test("the run end waits for the run's project: no record while another project is open", async () => {
  setup();
  start(byKey("test"));
  await settle();
  world.active = "/other";
  world.gates[0].resolve(PASSED);
  await settle();
  assert.equal(world.records.length, 0);
  await switchProject("/p");
  assert.equal(world.records.length, 1);
});

test("the outcome is announced to the Loop page and the boards, with the run's whole log", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  await finish(0, FAILED);
  const end = endOf();
  assert.equal(end.runId, runId);
  assert.equal(end.loopId, byKey("test").id);
  assert.equal(end.projectRoot, "/p");
  assert.equal(end.notice, "failed");
  assert.equal(end.refused, false);
  assert.ok(end.log.some((l) => l.startsWith("Loop failed")), "the lines written after the last live snapshot are in the event");
  assert.equal(rm.takeRunNotice(), null);
});

test("the run end waits for the run's project even when the run was cancelled while it was closed", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  world.active = "/other";
  rm.cancelRun(runId);
  world.gates[0].resolve({ ...FAILED, cancelled: true, statusSummary: "cancelled" });
  await settle();
  assert.equal(world.records.length, 0, "no record is written into another project");
  assert.equal(stateOf(runId), "paused");
  assert.equal(rm.liveRuns().find((r) => r.runId === runId).note, "Waiting for its project");
  await switchProject("/p");
  assert.equal(world.records.length, 1);
  assert.deepEqual(rm.liveRuns(), []);
});

test("loop runs report each step to onStage and their end to onRunFinished, like Factory runs", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  world.gates[0].deps.log("$ Verify");
  world.gates[0].deps.log("plain line");
  assert.deepEqual(world.stages, [runId]);
  await finish(0, PASSED);
  assert.equal(world.finishedInfo.length, 1);
  const info = world.finishedInfo[0];
  assert.equal(info.runId, runId);
  assert.equal(info.itemKey, `loop:${byKey("test").id}`);
  assert.equal(info.statusCode, runStatusCode(PASSED));
  assert.equal(info.mode, "full");
});

test("a refused run reports no finished info; a loop run has a progress value like a Factory run", async () => {
  setup({ approve: async () => null });
  start(byKey("test"));
  await settle();
  assert.equal(world.finishedInfo.length, 0);

  setup();
  const runId = start(byKey("test"));
  await settle();
  const cfg = byKey("test").config;
  const stage = cfg.stages.find((st) => st.enabled);
  world.gates[0].deps.onProgress({ type: "stage-start", stage, index: 1, count: 4, iteration: 1 });
  const live = rm.liveRuns().find((r) => r.runId === runId);
  assert.equal(live.progress.stageName, stage.name);
  assert.equal(live.progress.stageIndex, 1);
  assert.equal(live.progress.stageCount, 4);
  assert.equal(live.progress.maxIterations >= 1, true);
  await finish(0, PASSED);
});

test("Pause holds the run at the next step boundary and Resume continues it", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  rm.setRunPaused(runId, true);
  assert.equal(rm.liveRuns().find((r) => r.runId === runId).pauseRequested, true);
  let passed = false;
  const hold = world.gates[0].deps.holdWhilePaused(0).then((r) => { passed = true; return r; });
  await settle();
  assert.equal(passed, false);
  assert.equal(stateOf(runId), "paused");
  rm.setRunPaused(runId, false);
  assert.equal(await hold, "ok");
  assert.equal(stateOf(runId), "running");
  assert.equal(rm.liveRuns().find((r) => r.runId === runId).pauseRequested, undefined);
  await finish(0, PASSED);
});

test("a run held for review tells its observers so the Ship panel can open", async () => {
  setup();
  world.diffFiles = ["src/a.ts"];
  world.status = { changedFiles: 2, localCommits: 0, pushed: false };
  start(byKey("test"));
  await settle();
  await finish(0, PASSED);
  const ship = endOf().manualShip;
  assert.ok(ship, "a held run offers the manual Ship");
  assert.equal(ship.processName, "Test");
  assert.match(ship.info.runId, /^test-[0-9a-f]{8}$/);
  assert.equal(ship.entry.statusCode, "awaiting_review");
});

test("a signal event follows the run_finished signal; the Factory board ignores loop runs", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  const live = rm.liveRuns();
  assert.equal(rm.isLoopRun(live[0]), true);
  assert.equal(rm.loopIdOfRun(live[0]), byKey("test").id);
  assert.deepEqual(rm.factoryLiveRuns(), []);
  assert.equal(rm.factoryLiveRuns(), rm.factoryLiveRuns(), "stable between changes");
  await finish(0, PASSED);
  assert.equal(world.events.some((e) => e.type === "signal"), true);
  assert.equal(runId.length > 0, true);
});

test("a user Pause times out like the runner's pause: the hold returns timedOut and the run goes on", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  rm.setRunPaused(runId, true);
  const started = Date.now();
  assert.equal(await world.gates[0].deps.holdWhilePaused(1), "timedOut");
  assert.ok(Date.now() - started >= 900);
  const live = rm.liveRuns().find((r) => r.runId === runId);
  assert.equal(live.state, "running");
  assert.equal(live.pauseRequested, undefined);
  await finish(0, PASSED);
});

test("a Pause pressed while the run waits for its project still holds it afterwards", async () => {
  setup();
  const runId = start(byKey("test"));
  await settle();
  world.active = "/other";
  let released = false;
  const hold = world.gates[0].deps.holdWhilePaused(0).then(() => { released = true; });
  await settle();
  rm.setRunPaused(runId, true);
  await switchProject("/p");
  assert.equal(released, false);
  assert.equal(stateOf(runId), "paused");
  rm.setRunPaused(runId, false);
  await hold;
  assert.equal(stateOf(runId), "running");
  await finish(0, PASSED);
});

test("cancelling a queued loop run tells its listeners", async () => {
  setup();
  start(byKey("test"));
  const queued = start(byKey("plan"));
  rm.cancelRun(queued);
  const end = endOf();
  assert.equal(end.runId, queued);
  assert.equal(end.refused, true);
  assert.equal(end.notice, "Cancelled while queued");
  await settle();
  await finish(0, PASSED);
});
