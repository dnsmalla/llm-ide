import { test } from "node:test";
import assert from "node:assert/strict";
import * as rm from "../native/run-manager.ts";
import { FACTORY_TEMPLATE, configFor } from "../native/factory.ts";
import { runNativeLoop } from "../native/runner.ts";

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 30; i++) await tick(); }
function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
}

const PASSED = { passed: true, iterationsUsed: 1, stages: [], iterations: [], failedStage: null, statusSummary: "passed after 1 iteration" };
const FACTORY_LOOP = { id: "F", name: "Factory", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "factory", runsOnSchedule: false, config: structuredClone(FACTORY_TEMPLATE.config) };
const item = (n) => ({ key: `issue:${n}`, source: "issue", id: String(n), title: `Issue ${n}`, body: "Do it", repo: "", provider: null });

let world;
function setup(over = {}) {
  world = { active: "/p", listeners: new Set(), hostCalls: [], records: [], copies: [], ctxs: [], configs: [], gates: new Map(), list: [] };
  let seed = 1;
  let ids = 0;
  rm.resetRunManagerForTests();
  rm.configureRunManager({
    host: async (command, args) => {
      world.hostCalls.push([command, args, world.active]);
      if (command === "loop_worktree_prepare") return { runId: args.runId, project: world.active, repo: world.active, worktree: `${world.active}/system/loop-worktrees/${args.runId}`, branch: `factory/${args.runId}`, baseCommit: "abc1234def" };
      if (command === "loop_work_root") return world.active;
      if (command === "loop_worktree_list") return world.list;
      if (command === "loop_worktree_diff") return { text: "", truncated: false, patchId: "c".repeat(64), files: ["src/a.ts"] };
      if (command === "loop_changed_paths") return [];
      return null;
    },
    core: { async request() { return {}; } },
    fsFor: (root) => ({ root }),
    loadFactoryLoop: async () => FACTORY_LOOP,
    approve: async () => "tok",
    createStageDeps: (ctx) => {
      world.ctxs.push(ctx);
      return { __runId: ctx.runId, async runStage() { return { ok: true, output: "" }; }, async repair() { return { ok: true, output: "" }; }, halt: () => null, haltIsError: () => false };
    },
    runLoop: (config, deps) => { world.configs.push(config); const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; },
    appendRecord: async (fs, entry, record) => { world.records.push({ fs, entry, record }); },
    copyReadiness: async (fs, prefix, runId) => { world.copies.push({ fs, prefix, runId }); return false; },
    activeProject: () => world.active,
    subscribeProject: (l) => { world.listeners.add(l); return () => world.listeners.delete(l); },
    storage: memoryStorage(),
    now: () => new Date("2026-11-09T10:00:00Z"),
    rand: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    newId: () => `e${++ids}`,
    ...over,
  });
}
async function finish(runId, outcome = PASSED) { world.gates.get(runId).resolve(outcome); await settle(); }
async function switchProject(root) { world.active = root; for (const l of [...world.listeners]) l(); await settle(); }
const states = () => rm.liveRuns().map((r) => [r.runId, r.state]);

test("cap 2: third start is queued and starts when one finishes", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "full");
  const b = rm.startRun("/p", item(2), "full");
  const c = rm.startRun("/p", item(3), "full");
  await settle();
  assert.equal(rm.concurrency(), 2);
  assert.deepEqual(states(), [[a, "running"], [b, "running"], [c, "queued"]]);
  assert.equal(rm.liveRuns()[2].startedAt, null);
  const prepares = world.hostCalls.filter(([cmd]) => cmd === "loop_worktree_prepare");
  assert.equal(prepares.length, 2);
  assert.equal(prepares[0][1].runId, a);
  assert.equal(prepares[0][1].repoRel, "");
  assert.equal(prepares[0][1].base, null);
  assert.match(prepares[0][1].task, /Issue 1/);
  await finish(a);
  assert.deepEqual(states(), [[b, "running"], [c, "running"]]);
});

test("cancelRun cancels only that run and passes its runId to loop_cancel", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "full");
  const b = rm.startRun("/p", item(2), "full");
  await settle();
  rm.cancelRun(a);
  assert.deepEqual(world.hostCalls.filter(([c]) => c === "loop_cancel").map(([, args]) => args), [{ runId: a }]);
  const ctxA = world.ctxs.find((x) => x.runId === a);
  const ctxB = world.ctxs.find((x) => x.runId === b);
  assert.equal(ctxA.isCancelled(), true);
  assert.equal(ctxA.signal.aborted, true);
  assert.equal(ctxB.isCancelled(), false);
  await finish(a, { ...PASSED, passed: false, cancelled: true, statusSummary: "run cancelled" });
  assert.deepEqual(rm.liveRuns().map((r) => r.runId), [b]);
  assert.equal(world.records[0].entry.statusCode, "aborted");
  rm.setConcurrency(1);
  const c = rm.startRun("/p", item(3), "full");
  assert.deepEqual(states(), [[b, "running"], [c, "queued"]]);
  rm.cancelRun(c);
  assert.deepEqual(states(), [[b, "running"]]);
  assert.equal(world.hostCalls.filter(([cmd]) => cmd === "loop_cancel").length, 1, "a queued run is dropped without a host call");
});

test("a Loop-page run is listed as running, takes no slot, cannot be cancelled, and its release removes it", async () => {
  setup();
  rm.setConcurrency(1);
  let emits = 0;
  const unsubscribe = rm.subscribe(() => { emits += 1; });
  const release = rm.trackExternalRun({ runId: "L1", itemKey: "issue:github:acme/web#12", projectRoot: "/p" });
  const row = () => rm.liveRuns().find((r) => r.runId === "L1");
  assert.equal(row().state, "running");
  assert.equal(row().note, rm.LOOP_PAGE_NOTE);
  assert.equal(row().itemKey, "issue:github:acme/web#12");
  const managed = rm.startRun("/p", item(1), "full");
  await settle();
  assert.equal(rm.liveRuns().find((r) => r.runId === managed).state, "running", "the external run does not take the one slot");
  rm.cancelRun("L1");
  assert.equal(world.hostCalls.filter(([c]) => c === "loop_cancel").length, 0, "no host cancel for a Loop-page run");
  assert.ok(row(), "cancelRun leaves the row");
  const before = emits;
  release();
  assert.equal(row(), undefined, "release removes the row");
  assert.equal(emits, before + 1, "release emits once");
  release();
  unsubscribe();
  await finish(managed);
});

test("runs keep their projectRoot after the active project changes", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "full");
  const b = rm.startRun("/p", item(2), "full");
  await settle();
  await switchProject("/q");
  const c = rm.startRun("/q", item(3), "full");
  await settle();
  assert.deepEqual(rm.liveRuns().map((r) => [r.runId, r.projectRoot, r.state]), [[a, "/p", "running"], [b, "/p", "running"], [c, "/q", "queued"]]);
  assert.equal(rm.liveRuns().filter((r) => r.projectRoot !== "/q").length, 2, "the board's runs-live-in-other-projects count");
  const ctxA = world.ctxs.find((x) => x.runId === a);
  assert.equal(ctxA.projectRoot, "/p");
  assert.equal(ctxA.runRoot, `/p/system/loop-worktrees/${a}`);
  await finish(a);
  assert.equal(world.records.length, 0, "a's record waits until /p is open again");
  assert.equal(rm.liveRuns().find((r) => r.runId === c).state, "running");
  const prepC = world.hostCalls.find(([cmd, args]) => cmd === "loop_worktree_prepare" && args.runId === c);
  assert.equal(prepC[2], "/q", "c was prepared while its own project was open");
  await switchProject("/p");
  assert.equal(world.records.length, 1);
  assert.equal(world.records[0].record.worktree.runId, a);
  assert.equal(world.records[0].fs.root, "/p");
});

test("a queued run does not start while another project is open", async () => {
  setup();
  rm.setConcurrency(1);
  const a = rm.startRun("/p", item(1), "full");
  const b = rm.startRun("/p", item(2), "full");
  await settle();
  await switchProject("/q");
  await finish(a);
  assert.deepEqual(states(), [[b, "queued"]]);
  await switchProject("/p");
  assert.deepEqual(states(), [[b, "running"]]);
});

test("setConcurrency clamps to 1..4 and survives a storage throw", () => {
  const throwing = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  setup({ storage: throwing });
  assert.equal(rm.concurrency(), 2);
  rm.setConcurrency(9);
  assert.equal(rm.concurrency(), 4);
  rm.setConcurrency(0);
  assert.equal(rm.concurrency(), 1);
  rm.setConcurrency(Number.NaN);
  assert.equal(rm.concurrency(), 2);
  rm.setConcurrency(3.7);
  assert.equal(rm.concurrency(), 3);
});

test("concurrency is read from and written to llmide.factory.concurrency", () => {
  const storage = memoryStorage({ "llmide.factory.concurrency": "3" });
  setup({ storage });
  assert.equal(rm.concurrency(), 3);
  rm.setConcurrency(1);
  assert.equal(storage.getItem("llmide.factory.concurrency"), "1");
  setup({ storage: memoryStorage({ "llmide.factory.concurrency": "lots" }) });
  assert.equal(rm.concurrency(), 2);
  setup({ storage: memoryStorage({ "llmide.factory.concurrency": "7" }) });
  assert.equal(rm.concurrency(), 4);
});

test("a finished run is removed from liveRuns and its record is appended once", async () => {
  setup();
  let notified = 0;
  const off = rm.subscribe(() => { notified += 1; });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.deepEqual(rm.liveRuns(), []);
  assert.equal(world.records.length, 1);
  const { entry, record } = world.records[0];
  assert.equal(entry.id, "e1");
  assert.equal(entry.loopId, "F");
  assert.equal(entry.statusCode, "success");
  assert.equal(entry.trigger, "manual");
  assert.equal(typeof entry.factoryRunId, "string");
  assert.equal(entry.factoryMode, "full");
  assert.equal(record.factoryRunId, entry.factoryRunId);
  assert.equal(record.factoryMode, "full");
  assert.deepEqual(record.workItem, { source: "issue", id: "1", title: "Issue 1" });
  assert.deepEqual(record.worktree, { runId: a, branch: `factory/${a}`, baseCommit: "abc1234def", repo: "/p" });
  assert.equal(record.ship, null);
  assert.equal(record.needsDecision, null);
  assert.deepEqual(record.diffSummary, { files: ["src/a.ts"], truncated: false, patchId: "c".repeat(64), additions: null, deletions: null });
  assert.equal(record.gitRoot, `/p/system/loop-worktrees/${a}`);
  assert.deepEqual(world.copies.map((x) => [x.prefix, x.runId]), [[`system/loop-worktrees/${a}`, a]]);
  await settle();
  assert.equal(world.records.length, 1);
  assert.ok(notified >= 2);
  off();
});

test("an intake gate failure records the needs-decision reason", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "intakeOnly");
  await settle();
  assert.deepEqual(world.configs[0], configFor("intakeOnly", FACTORY_LOOP.config));
  await finish(a, { passed: false, iterationsUsed: 1, stages: [], iterations: [], failedStage: FACTORY_TEMPLATE.config.stages[2], statusSummary: "Intake gate failed; repair is disabled for this stage" });
  assert.equal(world.records[0].record.needsDecision, "needs decision: see .factory/READINESS.md");
  assert.equal(world.records[0].entry.statusCode, "failed");
});

test("a sendBack run with a runId reuses the existing worktree and never prepares a new one", async () => {
  setup();
  world.list = [{ runId: "r-old", project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r-old", branch: "factory/r-old", baseCommit: "abc" }];
  assert.throws(() => rm.startRun("/p", item(1), "continue"), /existing worktree/);
  assert.equal(rm.startRun("/p", item(1), "sendBack", { runId: "r-old" }), "r-old");
  assert.equal(rm.startRun("/p", item(1), "sendBack", { runId: "r-old" }), "r-old", "a live run id is not started twice");
  assert.equal(rm.liveRuns().length, 1);
  await settle();
  assert.equal(world.hostCalls.some(([c]) => c === "loop_worktree_prepare"), false);
  assert.equal(world.ctxs[0].runRoot, "/p/system/loop-worktrees/r-old");
  assert.deepEqual(world.configs[0], configFor("sendBack", FACTORY_LOOP.config));
  await finish("r-old");
  assert.deepEqual(world.copies, [], "sendBack does not re-copy the readiness report");
});

test("projectGuardedFs refuses every call while another project is open", async () => {
  let active = "/p";
  const inner = { async read(p) { return { status: "ok", text: p, hash: "h" }; } };
  const fs = rm.projectGuardedFs(inner, "/p", () => active);
  assert.equal((await fs.read("a.md")).text, "a.md");
  active = "/q";
  await assert.rejects(fs.read("a.md"), (e) => e.code === "no_project");
});

test("repoRelFor keeps a project-relative repo and otherwise derives it from the work root", () => {
  assert.equal(rm.repoRelFor("code/app", "/p", "/p"), "code/app");
  assert.equal(rm.repoRelFor("", "/p", "/p/code/x"), "");
  assert.equal(rm.repoRelFor("owner/name", "/p", "/p/code/x"), "code/x");
  assert.equal(rm.repoRelFor("code/..", "/p", null), "");
  assert.equal(rm.repoRelFor(null, "/p", null), "");
});

test("a running run holds at a stage boundary while another project is open and resumes after switching back", async () => {
  const first = deferred();
  const names = [];
  const twoStages = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stages: FACTORY_TEMPLATE.config.stages.slice(3, 5).map((s) => ({ ...s, enabled: true })) } };
  setup({
    loadFactoryLoop: async () => twoStages,
    runLoop: runNativeLoop,
    createStageDeps: () => ({
      async runStage(s) { names.push(s.name); if (names.length === 1) await first.promise; return { ok: true, output: "" }; },
      async repair() { return { ok: true, output: "" }; },
      halt: () => null,
      haltIsError: () => false,
    }),
  });
  rm.startRun("/p", item(1), "full");
  await settle();
  assert.deepEqual(names, ["Plan"]);
  await switchProject("/other");
  first.resolve();
  await settle();
  assert.deepEqual(names, ["Plan"], "the next stage does not start while another project is open");
  assert.equal(rm.liveRuns()[0].state, "paused");
  assert.equal(rm.liveRuns()[0].note, "Waiting for its project");
  await switchProject("/p");
  assert.deepEqual(names, ["Plan", "Implement"]);
  assert.deepEqual(rm.liveRuns(), []);
  assert.equal(world.records.length, 1);
});

test("an issue's repo is mapped through repoForSlug; an unmapped repo does not start the run and leaves a notice", async () => {
  setup({ repoForSlug: (provider, slug) => (provider === "github" && slug === "acme/web" ? "code/web" : null) });
  const a = rm.startRun("/p", { ...item(1), provider: "github", repo: "acme/web" }, "full");
  rm.startRun("/p", { ...item(2), provider: "github", repo: "acme/other" }, "full");
  await settle();
  const prepares = world.hostCalls.filter(([cmd]) => cmd === "loop_worktree_prepare");
  assert.deepEqual(prepares.map(([, args]) => [args.runId, args.repoRel]), [[a, "code/web"]]);
  assert.deepEqual(states(), [[a, "running"]]);
  assert.match(rm.takeRunNotice(), /acme\/other/);
  assert.equal(rm.takeRunNotice(), null, "a notice is taken once");
});

test("a Factory loop whose Verify has no command does not start and says where to set it", async () => {
  const noCommand = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stages: FACTORY_TEMPLATE.config.stages.map((s) => (s.name === "Verify" ? { ...s, command: "" } : s)) } };
  setup({ loadFactoryLoop: async () => noCommand });
  rm.startRun("/p", item(1), "full");
  await settle();
  assert.match(rm.takeRunNotice(), /“Verify” stage has no test command.*did not start/);
  assert.equal(world.configs.length, 0, "the loop never starts");
});

test("a project without a Factory loop leaves a notice", async () => {
  setup({ loadFactoryLoop: async () => null });
  rm.startRun("/p", item(1), "full");
  await settle();
  assert.deepEqual(rm.liveRuns(), []);
  assert.match(rm.takeRunNotice(), /no Factory loop/);
});

test("runs that start together in a project without a Factory loop all get the one loop that is added", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  for (const initial of [{}, { "system/loop.json": JSON.stringify({ schemaVersion: 2, loops: [] }) }]) {
    const fs = memFs(initial);
    const loops = await Promise.all([rm.loadOrCreateFactoryLoop(fs), rm.loadOrCreateFactoryLoop(fs), rm.loadOrCreateFactoryLoop(fs)]);
    assert.equal(new Set(loops.map((l) => l.id)).size, 1, "every run sees the same loop");
    const saved = JSON.parse(fs.files.get("system/loop.json")).loops.filter((l) => l.defaultKey === "factory");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].id, loops[0].id);
  }
});

test("a Factory run writes .factory/RUN.json and removes it after the record", async () => {
  const marks = [];
  setup({ fsFor: () => ({ write: async (path) => { marks.push(["write", path]); }, remove: async (path) => { marks.push(["remove", path]); } }) });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  assert.deepEqual(marks.find(([k]) => k === "write")?.[1], "system/loop-worktrees/" + a + "/.factory/RUN.json");
  await finish(a);
  assert.deepEqual(marks.find(([k]) => k === "remove")?.[1], "system/loop-worktrees/" + a + "/.factory/RUN.json");
});

test("LiveRun.progress follows the runner events", async () => {
  let emit;
  setup({ runLoop: (_config, deps) => { emit = deps.onProgress; const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  emit({ type: "iteration", iteration: 2 });
  emit({ type: "stage-start", stage: { id: "s1", name: "Implement" }, index: 3, count: 8, iteration: 2 });
  await settle();
  const p = rm.liveRuns().find((r) => r.runId === a).progress;
  assert.deepEqual([p.stageName, p.stageIndex, p.stageCount, p.iteration, p.repairs], ["Implement", 3, 8, 2, 0]);
  emit({ type: "repair", stage: { id: "s1", name: "Implement" }, attempt: 1 });
  await settle();
  assert.equal(rm.liveRuns().find((r) => r.runId === a).progress.repairs, 1);
});
