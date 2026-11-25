import { test, mock } from "node:test";
import assert from "node:assert/strict";
import * as rm from "../native/run-manager.ts";
import { FACTORY_BUILT_IN_STAGES, FACTORY_TEMPLATE, configFor } from "../native/factory.ts";
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
// A process that still has Intake (the default leaves it out; a person can add it back).
const WITH_INTAKE = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stageDelaySeconds: 0, stages: structuredClone(FACTORY_BUILT_IN_STAGES) } };
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

test("the run opens its MR right after its record is written, and never from a record held for a closed project", async () => {
  const calls = [];
  setup({ autoShip: async (e) => { calls.push(e); return "Draft MR: https://gitlab.com/g/p/-/merge_requests/1"; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.id, world.records[0].entry.id, "the MR is recorded on the record just written");
  assert.deepEqual({ runId: calls[0].runId, statusCode: calls[0].statusCode, needsDecision: calls[0].needsDecision, branch: calls[0].info.branch }, { runId: a, statusCode: "success", needsDecision: false, branch: `factory/${a}` });
  const b = rm.startRun("/p", item(2), "full");
  await settle();
  await switchProject("/other");
  await finish(b);
  assert.equal(calls.length, 1, "a held record has no MR yet");
});

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

test("an intake-only run is refused when the process has no Intake step, instead of passing as \"Intake ready\"", async () => {
  setup();
  rm.startRun("/p", item(1), "intakeOnly");
  await settle();
  assert.equal(world.configs.length, 0, "nothing runs");
  assert.deepEqual(world.records, [], "no run record, so no card turns Intake ready");
  assert.match(rm.takeRunNotice(), /no Intake step; add one in Factory → Process\. The run did not start\./);
});

test("an intake gate failure records the needs-decision reason", async () => {
  setup({ loadFactoryLoop: async () => WITH_INTAKE });
  const a = rm.startRun("/p", item(1), "intakeOnly");
  await settle();
  assert.deepEqual(world.configs[0], configFor("intakeOnly", WITH_INTAKE.config));
  await finish(a, { passed: false, iterationsUsed: 1, stages: [], iterations: [], failedStage: FACTORY_BUILT_IN_STAGES[2], statusSummary: "Intake gate failed; repair is disabled for this stage" });
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
  const twoStages = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stageDelaySeconds: 0, stages: FACTORY_BUILT_IN_STAGES.slice(3, 5).map((s) => ({ ...structuredClone(s), enabled: true })) } };
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
  const noCommand = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stageDelaySeconds: 0, stages: FACTORY_TEMPLATE.config.stages.map((s) => (s.name === "Verify" ? { ...s, command: "" } : s)) } };
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

test("the Factory's steps come from system/factory-template.json: written once from the loop, applied, refused when invalid", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  const tpl = await import("../native/factory-template.ts");
  const fs = memFs();
  const loop = await rm.loadOrCreateFactoryLoop(fs);
  const written = fs.files.get(tpl.TEMPLATE_FILE);
  assert.equal(written, tpl.formatFactoryTemplate(tpl.templateFromLoop(loop).template), "a project without a template gets one written from its loop");

  const edited = tpl.parseFactoryTemplate(written).template;
  edited.stages = edited.stages.map((s) => (s.role === "implement" ? { ...s, prompt: "Keep the change small." } : s));
  fs.put(tpl.TEMPLATE_FILE, tpl.formatFactoryTemplate(edited));
  const applied = await rm.loadOrCreateFactoryLoop(fs);
  assert.equal(applied.config.stages.find((s) => s.name === "Implement").prompt, "Keep the change small.");
  const saved = JSON.parse(fs.files.get("system/loop.json")).loops.find((l) => l.defaultKey === "factory");
  assert.equal(saved.config.stages.find((s) => s.name === "Implement").prompt, "Keep the change small.", "saved before the run, so the host approves what runs");

  fs.put(tpl.TEMPLATE_FILE, '{\n  "version": 1,\n  "stages": [\n    { "role": "implemnt" }\n  ]\n}\n');
  await assert.rejects(rm.loadOrCreateFactoryLoop(fs), /Fix system\/factory-template\.json.*line 4: stages\[0\]\.role: unknown role "implemnt".*did not start/);
});

test("a migration that cannot keep a step writes the template but stops the run once, naming each step and why", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  const tpl = await import("../native/factory-template.ts");
  const first = memFs();
  await rm.loadOrCreateFactoryLoop(first);
  const store = JSON.parse(first.files.get("system/loop.json"));
  const factory = store.loops.find((l) => l.defaultKey === "factory");
  factory.config.stages.push({ ...factory.config.stages[0], id: "g", name: "Graph snapshot", kind: "codeGraph", command: null, order: 99 });
  const fs = memFs({ "system/loop.json": JSON.stringify(store) });
  await assert.rejects(rm.loadOrCreateFactoryLoop(fs), /Graph snapshot: a "codeGraph" step cannot be written in the template.*review system\/factory-template\.json \(Factory → Process\)/s);
  assert.ok(fs.files.has(tpl.TEMPLATE_FILE), "the template is written anyway");
  const next = await rm.loadOrCreateFactoryLoop(fs);
  assert.equal(next.config.stages.some((s) => s.name === "Graph snapshot"), false, "the second run goes ahead with the template");
});

test("a new project gets the default process, with Structure verify on when a lint script is detected", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  const tpl = await import("../native/factory-template.ts");
  const fs = memFs({ "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }) });
  const loop = await rm.loadOrCreateFactoryLoop(fs);
  assert.deepEqual(loop.config.stages.map((s) => s.name), ["Set up", "Plan", "Implement", "Structure verify", "Verify", "Test gaps", "Doc review", "Review", "Review gate"]);
  const structure = loop.config.stages.find((s) => s.name === "Structure verify");
  assert.deepEqual({ command: structure.command, enabled: structure.enabled, id: structure.id }, { command: "npm run lint", enabled: true, id: "custom/structure-verify-1" });
  assert.equal(loop.config.stages.find((s) => s.name === "Verify").command, "npm test");
  const written = tpl.parseFactoryTemplate(fs.files.get(tpl.TEMPLATE_FILE)).template;
  assert.equal(written.stages.some((s) => s.role === "intake"), false);
});

test("a project whose loop is the unedited previous default moves to the new process; an existing template is never touched", async () => {
  const { memFs } = await import("../../factory/tests/mem-fs.mjs");
  const tpl = await import("../native/factory-template.ts");
  const first = memFs();
  await rm.loadOrCreateFactoryLoop(first);
  const store = JSON.parse(first.files.get("system/loop.json"));
  const factory = store.loops.find((l) => l.defaultKey === "factory");
  factory.config.stages = structuredClone(FACTORY_BUILT_IN_STAGES).map((s) => (s.name === "Verify" ? { ...s, command: "pytest" } : s));
  const fs = memFs({ "system/loop.json": JSON.stringify(store) });
  const loop = await rm.loadOrCreateFactoryLoop(fs);
  assert.equal(loop.config.stages.some((s) => s.name === "Intake"), false);
  assert.equal(loop.config.stages.find((s) => s.name === "Verify").command, "pytest", "its own Verify command is kept");
  const own = tpl.formatFactoryTemplate({ version: 1, stages: [{ role: "intake" }, { role: "intakeGate" }, { role: "implement" }, { role: "verify", command: "pytest" }, { role: "review" }, { role: "reviewGate" }] });
  const kept = memFs({ "system/loop.json": JSON.stringify(store), [tpl.TEMPLATE_FILE]: own });
  const keptLoop = await rm.loadOrCreateFactoryLoop(kept);
  assert.equal(kept.files.get(tpl.TEMPLATE_FILE), own);
  assert.deepEqual(keptLoop.config.stages.map((s) => s.name), ["Intake", "Intake gate", "Implement", "Verify", "Review", "Review gate"]);
});

test("a run whose Test gaps step writes a test file still passes and reaches its MR (the test is not reverted)", async () => {
  const { createStageDeps } = await import("../native/stage-exec.ts");
  const gaps = structuredClone(FACTORY_TEMPLATE.config.stages.find((s) => s.name === "Test gaps"));
  const loop = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stageDelaySeconds: 0, stages: [{ ...gaps, order: 0 }] } };
  const shipped = [];
  let agentRan = false;
  setup({
    loadFactoryLoop: async () => loop,
    runLoop: runNativeLoop,
    createStageDeps,
    host: async (command, args) => {
      world.hostCalls.push([command, args, world.active]);
      if (command === "loop_worktree_prepare") return { runId: args.runId, project: "/p", repo: "/p", worktree: `/p/system/loop-worktrees/${args.runId}`, branch: `factory/${args.runId}`, baseCommit: "abc1234def" };
      if (command === "loop_changed_paths") return agentRan ? ["tests/button.test.ts"] : [];
      return null;
    },
    core: { async request(path) { if (path === "/kb/loop/agent-run") { agentRan = true; return { reply: "added a test", resultSubtype: "success", changedPaths: ["tests/button.test.ts"], createdPaths: ["tests/button.test.ts"] }; } return {}; } },
    autoShip: async (e) => { shipped.push(e.statusCode); return "Draft MR: https://example/mr/1"; },
  });
  rm.startRun("/p", item(1), "full");
  await settle();
  assert.equal(agentRan, true);
  assert.equal(world.hostCalls.some(([c]) => c === "loop_revert_paths"), false, "the new test is kept");
  assert.deepEqual(shipped, ["success"], "the run passed and opened its MR");
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

test("the run marker names the step the run is on, and no step write lands after the marker is removed", async () => {
  const marks = [];
  let emit;
  let releaseWrite;
  setup({
    fsFor: () => ({
      write: async (path, text, opts) => { if (opts.force) await new Promise((r) => { releaseWrite = r; }); marks.push(["write", text, opts.force === true]); },
      remove: async () => { marks.push(["remove"]); },
    }),
    runLoop: (_config, deps) => { emit = deps.onProgress; const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; },
  });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  emit({ type: "stage-start", stage: { id: "s1", name: "Implement" }, index: 0, count: 2, iteration: 1 });
  const done = finish(a);
  await settle();
  assert.equal(marks.some(([k]) => k === "remove"), false, "the run waits for the pending step write before it ends");
  releaseWrite();
  await done;
  await settle();
  const stepWrite = marks.findIndex(([k, , force]) => k === "write" && force);
  assert.equal(JSON.parse(marks[stepWrite][1]).stage, "Implement");
  assert.ok(marks.findIndex(([k]) => k === "remove") > stepWrite, "the marker is removed after the last step write");
});

test("a finished stage is reported with its run, item and worktree path, and a throwing listener does not stop the run", async () => {
  let emit;
  const seen = [];
  setup({
    runLoop: (_config, deps) => { emit = deps.onProgress; const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; },
    onStageResult: (e) => { seen.push(e); throw new Error("listener bug"); },
  });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  emit({ type: "stage-result", stage: { id: "s1", name: "Implement" }, ok: true, iteration: 1 });
  await settle();
  assert.equal(seen.length, 1);
  assert.deepEqual({ runId: seen[0].runId, projectRoot: seen[0].projectRoot, mode: seen[0].mode, key: seen[0].item.key, name: seen[0].stage.name, ok: seen[0].ok }, { runId: a, projectRoot: "/p", mode: "full", key: item(1).key, name: "Implement", ok: true });
  assert.match(seen[0].runPrefix, new RegExp(`${a}$`));
  assert.equal(rm.liveRuns().find((r) => r.runId === a).progress.stages[0]?.state ?? "passed", "passed");
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

test("a step review sets the live sub-state and its verdicts reach the record, findings capped at 2000", async () => {
  let emit;
  setup({ runLoop: (_config, deps) => { emit = deps.onProgress; const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  const live = () => rm.liveRuns().find((r) => r.runId === a);
  const impl = { id: "s1", name: "Implement" };
  emit({ type: "stage-start", stage: impl, index: 3, count: 8, iteration: 1 });
  emit({ type: "step-review", stage: impl, phase: "reviewing", attempt: 1 });
  await settle();
  assert.equal(live().progress.substate, "reviewing");
  emit({ type: "step-review", stage: impl, phase: "fixing", attempt: 1 });
  await settle();
  assert.equal(live().progress.substate, "fixing review");
  emit({ type: "step-review-result", stage: impl, verdict: "approve", attempts: 1 });
  await settle();
  assert.equal(live().progress.substate, null);
  emit({ type: "step-review", stage: impl, phase: "reviewing", attempt: 1 });
  emit({ type: "stage-start", stage: { id: "s2", name: "Verify" }, index: 4, count: 8, iteration: 1 });
  await settle();
  assert.equal(live().progress.substate, null, "a new stage clears the sub-state");
  const stepReviews = [
    { stageId: "s1", stageName: "Implement", verdict: "approve", attempts: 1, findings: "" },
    { stageId: "s2", stageName: "Verify", verdict: "unresolved", attempts: 3, findings: "x".repeat(2500), reason: "repair budget exhausted" },
  ];
  await finish(a, { ...PASSED, stepReviews });
  const { record } = world.records[0];
  assert.deepEqual(record.stepReviews, [
    { stageName: "Implement", verdict: "approve", attempts: 1, findings: "" },
    { stageName: "Verify", verdict: "unresolved", attempts: 3, findings: "x".repeat(2000), reason: "repair budget exhausted" },
  ]);
});

test("a record has no stepReviews key when no step was reviewed", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.equal("stepReviews" in world.records[0].record, false);
});

test("startRun does not start a second live run for the same item, project and mode", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "full");
  assert.equal(rm.startRun("/p", item(1), "full"), a, "a double click returns the existing run");
  await settle();
  assert.equal(rm.startRun("/p", item(1), "full"), a, "also while it is running");
  const other = rm.startRun("/p", item(2), "full");
  assert.notEqual(other, a);
  assert.equal(rm.liveRuns().length, 2);
  await settle();
  assert.equal(world.hostCalls.filter(([cmd]) => cmd === "loop_worktree_prepare").length, 2, "one worktree per item");
  await finish(a);
  const again = rm.startRun("/p", item(1), "full");
  assert.notEqual(again, a, "an ended run no longer blocks a new one");
});

test("runs held for another project do not count against the parallel-runs cap", async () => {
  const gates = [];
  const twoStages = { ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_TEMPLATE.config), stageDelaySeconds: 0, stages: FACTORY_BUILT_IN_STAGES.slice(3, 5).map((s) => ({ ...structuredClone(s), enabled: true })) } };
  setup({
    loadFactoryLoop: async () => twoStages,
    runLoop: runNativeLoop,
    createStageDeps: () => ({
      async runStage(s) { if (s.name === "Plan") { const g = deferred(); gates.push(g); await g.promise; } return { ok: true, output: "" }; },
      async repair() { return { ok: true, output: "" }; },
      halt: () => null,
      haltIsError: () => false,
    }),
  });
  rm.startRun("/p", item(1), "full");
  rm.startRun("/p", item(2), "full");
  await settle();
  await switchProject("/q");
  for (const g of gates) g.resolve();
  await settle();
  assert.deepEqual(rm.liveRuns().map((r) => r.state), ["paused", "paused"]);
  const c = rm.startRun("/q", item(3), "full");
  await settle();
  assert.equal(rm.liveRuns().find((r) => r.runId === c).state, "running", "the open project's run is not blocked by the held ones");
});

test("reviewMode human holds a passing run as awaiting_review and ships nothing", async () => {
  const shipped = [];
  setup({
    loadFactoryLoop: async () => ({ ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_LOOP.config), reviewMode: "human" } }),
    autoShip: async (e) => { shipped.push(e.statusCode); return ""; },
  });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  const rec = world.records.at(-1);
  assert.equal(rec.record.statusCode, "awaiting_review");
  assert.equal(rec.entry.statusCode, "awaiting_review");
  assert.equal(rec.record.awaiting.held, "success");
  assert.equal(rec.record.awaiting.kind, "passed");
  assert.deepEqual(shipped, ["awaiting_review"]);
});

test("without reviewMode a passing run is success; a cancelled or errored run is never held", async () => {
  setup();
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.equal(world.records.at(-1).record.statusCode, "success");
  assert.equal(world.records.at(-1).record.awaiting, undefined);
  setup({ loadFactoryLoop: async () => ({ ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_LOOP.config), reviewMode: "human" } }) });
  const b = rm.startRun("/p", item(2), "full");
  await settle();
  await finish(b, { ...PASSED, passed: false, cancelled: true });
  assert.equal(world.records.at(-1).record.statusCode, "aborted");
  const c = rm.startRun("/p", item(3), "full");
  await settle();
  await finish(c, { ...PASSED, passed: false, errored: true });
  assert.equal(world.records.at(-1).record.statusCode, "error");
});

test("shipHeldRun ships a held run through autoShip as a success and starts no run", async () => {
  const shipped = [];
  setup({ autoShip: async (e) => { shipped.push(e); return "Draft MR: https://example/mr/9"; } });
  world.list = [{ runId: "r9", project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r9", branch: "factory/r9", baseCommit: "abc" }];
  const line = await rm.shipHeldRun("/p", item(9), { runId: "r9", entry: { id: "e1", startedAt: "2026-11-09T10:00:00Z" }, awaiting: { held: "success", kind: "passed", failedStage: null } });
  assert.equal(line, "Draft MR: https://example/mr/9");
  assert.equal(shipped.length, 1);
  assert.deepEqual({ runId: shipped[0].runId, statusCode: shipped[0].statusCode, needsDecision: shipped[0].needsDecision, prefix: shipped[0].runPrefix, entry: shipped[0].entry.id }, { runId: "r9", statusCode: "success", needsDecision: false, prefix: "system/loop-worktrees/r9", entry: "e1" });
  assert.equal(rm.liveRuns().length, 0, "approving starts no run");
});

test("shipHeldRun of a failed hold keeps the failed status and the stored kind", async () => {
  const shipped = [];
  setup({ autoShip: async (e) => { shipped.push(e); return ""; } });
  world.list = [{ runId: "r9", project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r9", branch: "factory/r9", baseCommit: "abc" }];
  const verify = FACTORY_LOOP.config.stages.find((s) => s.kind === "command" || /verify|test/i.test(s.name));
  await rm.shipHeldRun("/p", item(9), { runId: "r9", entry: { id: "e1", startedAt: "x" }, awaiting: { held: "failed", kind: "testsFailing", failedStage: verify.name } });
  assert.equal(shipped[0].statusCode, "failed");
  assert.equal(shipped[0].kind, "testsFailing");
});

test("shipHeldRun without an autoShip dep, or without the worktree, returns a line and throws nothing", async () => {
  setup({ autoShip: undefined });
  assert.equal(await rm.shipHeldRun("/p", item(9), { runId: "r9", entry: { id: "e1", startedAt: "x" }, awaiting: { held: "success", kind: "passed", failedStage: null } }), "");
  setup({ autoShip: async () => "never" });
  world.list = [];
  assert.match(await rm.shipHeldRun("/p", item(9), { runId: "r9", entry: { id: "e1", startedAt: "x" }, awaiting: { held: "success", kind: "passed", failedStage: null } }), /worktree/);
});

const markerFs =(marks) => () => ({ write: async (path) => { marks.push(["write", path]); }, remove: async (path) => { marks.push(["remove", path]); } });

test("a run that throws after the marker write removes the marker and reports the error", async () => {
  const marks = [];
  setup({ fsFor: markerFs(marks), runLoop: () => { throw new Error("boom"); } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  const marker = "system/loop-worktrees/" + a + "/.factory/RUN.json";
  assert.ok(marks.some(([k, p]) => k === "write" && p === marker));
  assert.ok(marks.some(([k, p]) => k === "remove" && p === marker), "no marker left to show Interrupted forever");
  assert.match(rm.takeRunNotice(), /boom/);
});

test("a run that throws while another project is open holds the marker clear until its project is open again", async () => {
  const storage = memoryStorage();
  const marks = [];
  let rejectRun;
  setup({ storage, fsFor: markerFs(marks), runLoop: () => new Promise((_, reject) => { rejectRun = reject; }) });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  const marker = "system/loop-worktrees/" + a + "/.factory/RUN.json";
  await switchProject("/other");
  rejectRun(new Error("boom"));
  await settle();
  assert.equal(marks.some(([k]) => k === "remove"), false, "no remove attempted against the wrong project");
  const held = JSON.parse(storage.getItem("llmide.factory.pendingRecords"));
  assert.equal(held.length, 1);
  assert.equal(held[0].markerOnly, true);
  assert.equal(held[0].marker, marker);
  const after = [];
  setup({ storage, fsFor: markerFs(after) });
  await settle();
  assert.deepEqual(after.filter(([k]) => k === "remove").map(([, p]) => p), [marker]);
  assert.equal(world.records.length, 0, "a marker-only entry writes no record");
  assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
});

test("a refused marker remove on a throw is held, and never throws into execute", async () => {
  const storage = memoryStorage();
  setup({ storage, fsFor: () => ({ write: async () => {}, remove: async () => { throw new Error("no_project"); } }), runLoop: () => { throw new Error("boom"); } });
  rm.startRun("/p", item(1), "full");
  await settle();
  assert.equal(JSON.parse(storage.getItem("llmide.factory.pendingRecords")).length, 1);
  assert.match(rm.takeRunNotice(), /boom/);
  assert.equal(rm.liveRuns().length, 0, "the run still ended");
});

test("a record held for a closed project survives a restart and is written when the project is open at launch", async () => {
  const storage = memoryStorage();
  const marks = [];
  setup({ storage, fsFor: markerFs(marks) });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await switchProject("/other");
  await finish(a);
  assert.equal(world.records.length, 0);
  const held = JSON.parse(storage.getItem("llmide.factory.pendingRecords"));
  assert.equal(held.length, 1);
  assert.equal(held[0].projectRoot, "/p");
  // The app quits and relaunches with /p already open.
  const after = [];
  setup({ storage, fsFor: markerFs(after) });
  await settle();
  assert.equal(world.records.length, 1);
  assert.equal(world.records[0].entry.factoryRunId, a);
  assert.equal(world.copies.length, 1);
  assert.ok(after.some(([k, p]) => k === "remove" && p.endsWith("/.factory/RUN.json")));
  assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
});

test("a failed write keeps the stored record for the next flush", async () => {
  const storage = memoryStorage();
  setup({ storage });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await switchProject("/other");
  await finish(a);
  let fail = true;
  setup({ storage, appendRecord: async (fs, entry, record) => { if (fail) throw new Error("disk"); world.records.push({ entry, record }); } });
  await settle();
  assert.equal(world.records.length, 0);
  assert.equal(JSON.parse(storage.getItem("llmide.factory.pendingRecords")).length, 1, "kept");
  fail = false;
  await switchProject("/other");
  await switchProject("/p");
  assert.equal(world.records.length, 1);
  assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
});

test("a record held in memory is written once, and without storage the in-memory path still works", async () => {
  setup({ storage: undefined });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await switchProject("/other");
  await finish(a);
  assert.equal(world.records.length, 0);
  await switchProject("/p");
  assert.equal(world.records.length, 1);
  await switchProject("/other");
  await switchProject("/p");
  assert.equal(world.records.length, 1, "not written twice");
});

test("a second concurrent shipHeldRun for the same run calls autoShip once", async () => {
  const gate = deferred();
  let calls = 0;
  setup({ autoShip: async () => { calls++; await gate.promise; return "Draft MR: https://example/mr/1"; } });
  world.list = [{ runId: "r9", project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r9", branch: "factory/r9", baseCommit: "abc" }];
  const facts = { runId: "r9", entry: { id: "e1", startedAt: "x" }, awaiting: { held: "success", kind: "passed", failedStage: null } };
  const first = rm.shipHeldRun("/p", item(9), facts);
  await settle();
  assert.match(await rm.shipHeldRun("/p", item(9), facts), /Already opening/);
  gate.resolve();
  assert.match(await first, /Draft MR/);
  assert.equal(calls, 1);
  assert.match(await rm.shipHeldRun("/p", item(9), facts), /Draft MR/, "after it finishes, the guard is released");
});

test("shipHeldRun refuses a stale record: already shipped or no longer awaiting review", async () => {
  let calls = 0;
  setup({ autoShip: async () => { calls++; return "x"; } });
  world.list = [{ runId: "r9", project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r9", branch: "factory/r9", baseCommit: "abc" }];
  const base = { runId: "r9", entry: { id: "e1", startedAt: "x" }, awaiting: { held: "success", kind: "passed", failedStage: null } };
  assert.match(await rm.shipHeldRun("/p", item(9), { ...base, shipped: true, statusCode: "awaiting_review" }), /no longer waiting/);
  assert.match(await rm.shipHeldRun("/p", item(9), { ...base, statusCode: "success" }), /no longer waiting/);
  assert.equal(calls, 0);
});

test("a held failed run whose stage no longer exists still ships with its stored kind", async () => {
  const shipped = [];
  setup({ autoShip: async (e) => { shipped.push(e); return ""; } });
  world.list = [{ runId: "r9", project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r9", branch: "factory/r9", baseCommit: "abc" }];
  await rm.shipHeldRun("/p", item(9), { runId: "r9", entry: { id: "e1", startedAt: "x" }, awaiting: { held: "failed", kind: "testsFailing", failedStage: "Renamed away" } });
  assert.equal(shipped[0].kind, "testsFailing");
  assert.equal(shipped[0].statusCode, "failed");
});

// Verify loopback: a failed run never opens an MR; only a passed one ships (auto) or is held (human).
const verifyStage = () => FACTORY_LOOP.config.stages.find((s) => s.id === "factory/verify");
const reviewGateStage = () => FACTORY_LOOP.config.stages.find((s) => s.id === "factory/review-gate");
const FAILED = (over = {}) => ({ passed: false, iterationsUsed: 1, stages: [], iterations: [], failedStage: verifyStage(), statusSummary: "tests failed", ...over });

test("a loopback-stopped run opens no MR and records stopped.limit with its loopback summary", async () => {
  const shipped = [];
  const finishedInfo = [];
  const loopback = { rounds: 3, maxRounds: 3, reason: "tests", findings: "boom", stopped: true };
  // An early event makes the manager publish the run's progress.
  setup({ autoShip: async (e) => { shipped.push(e); return "x"; }, onRunFinished: (i) => finishedInfo.push(i), runLoop: (config, deps) => { world.configs.push(config); deps.onProgress({ type: "iteration", iteration: 1 }); const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  assert.equal(rm.liveRuns()[0].progress.maxIterations, FACTORY_LOOP.config.maxIterations);
  const notes = [];
  rm.subscribe?.(() => notes.push(rm.liveRuns()[0]?.note ?? null));
  await finish(a, FAILED({ stoppedAtLimit: true, iterationsUsed: 3, statusSummary: "Stopped after 3 rounds: tests still failing", loopback }));
  assert.equal(shipped.length, 0);
  const rec = world.records.at(-1);
  assert.equal(rec.record.statusCode, "stopped.limit");
  assert.deepEqual(rec.record.loopback, loopback);
  assert.equal(finishedInfo[0].statusCode, "stopped.limit");
  assert.equal(notes.includes("Opening the MR"), false);
});

test("a stopped run in human review mode is not held: no awaiting field, not awaiting_review", async () => {
  setup({ loadFactoryLoop: async () => ({ ...FACTORY_LOOP, config: { ...structuredClone(FACTORY_LOOP.config), reviewMode: "human" } }), autoShip: async () => "x" });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a, FAILED({ stoppedAtLimit: true }));
  const rec = world.records.at(-1).record;
  assert.equal(rec.statusCode, "stopped.limit");
  assert.equal("awaiting" in rec, false);
});

for (const [label, mode, outcome, opts] of [
  ["a plain failed Verify in full mode", "full", FAILED()],
  ["a failed run in check mode", "check", FAILED(), { runId: "r-old" }],
  ["a rejected final Review gate", "full", FAILED({ failedStage: reviewGateStage() })],
]) {
  test(`${label} is stopped.limit and opens no MR`, async () => {
    const shipped = [];
    setup({ autoShip: async (e) => { shipped.push(e); return "x"; } });
    if (opts) world.list = [{ runId: opts.runId, project: "/p", repo: "/p", worktree: "/p/system/loop-worktrees/r-old", branch: "factory/r-old", baseCommit: "abc1234def" }];
    const a = rm.startRun("/p", item(1), mode, opts ?? {});
    await settle();
    await finish(a, outcome);
    assert.equal(shipped.length, 0);
    assert.equal(world.records.at(-1).record.statusCode, "stopped.limit");
  });
}

test("cancelled, errored and blocked runs keep their own states; none ships", async () => {
  const shipped = [];
  for (const [flag, code] of [[{ cancelled: true }, "aborted"], [{ errored: true }, "error"], [{ blocked: true }, "blocked.repair_out_of_scope"]]) {
    setup({ autoShip: async (e) => { shipped.push(e); return "x"; } });
    const a = rm.startRun("/p", item(1), "full");
    await settle();
    await finish(a, FAILED(flag));
    assert.equal(world.records.at(-1).record.statusCode, code);
  }
  // autoShip is still called for these (its kind rule refuses them), but never with the stopped code.
  assert.equal(shipped.some((e) => e.statusCode === "stopped.limit"), false);
});

test("a passed run still ships in auto mode", async () => {
  const shipped = [];
  setup({ autoShip: async (e) => { shipped.push(e.statusCode); return "x"; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.deepEqual(shipped, ["success"]);
});

test("a loopback event marks the Verify row failed and clears the sub-state", async () => {
  let onProgress;
  setup({ runLoop: (config, deps) => { onProgress = deps.onProgress; world.configs.push(config); const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  const verify = verifyStage();
  onProgress({ type: "stage-start", stage: verify, index: 5, count: 8, iteration: 1 });
  onProgress({ type: "step-review", stage: verify, phase: "reviewing" });
  onProgress({ type: "loopback", stage: verify, round: 1, maxRounds: 3, reason: "tests" });
  const progress = rm.liveRuns()[0].progress;
  assert.equal(progress.stages.find((r) => r.id === verify.id).state, "failed");
  assert.equal(progress.substate, null);
  await finish(a);
});

test("a record held for a closed project posts exactly one run_finished when it is flushed on reopen", async () => {
  const posts = [];
  const core = { async request(path, opts) { if (path === "/health") return { apiVersion: 150 }; if (path === "/kb/loop/improve/signal") { posts.push(opts.body); return { duplicate: false }; } return {}; } };
  setup({ core });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await switchProject("/other");
  await finish(a);
  assert.equal(posts.length, 0, "nothing is posted while the record is held");
  await switchProject("/p");
  await switchProject("/other");
  await switchProject("/p");
  assert.equal(world.records.length, 1);
  assert.equal(posts.length, 1);
  assert.deepEqual({ kind: posts[0].kind, projectRoot: posts[0].projectRoot, loopId: posts[0].loopId, runId: posts[0].runId, passed: posts[0].payload.passed }, { kind: "run_finished", projectRoot: "/p", loopId: "F", runId: world.records[0].entry.id, passed: true });
});

test("a failing core never breaks the record write", async () => {
  setup({ core: { async request() { throw new Error("down"); } } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.equal(world.records.length, 1);
});

test("a held record with malformed fields (the reader already drops non-object records) still completes its write and posts at most one signal", async () => {
  const posts = [];
  const core = { async request(path, opts) { if (path === "/health") return { apiVersion: 150 }; posts.push(opts.body); return {}; } };
  const copies = [];
  const storage = memoryStorage({ "llmide.factory.pendingRecords": JSON.stringify([{ projectRoot: "/p", entry: { id: "x1", loopId: "F", startedAt: "t" }, record: { stages: 5, stepReviews: "x", loopback: 3, costUsd: "n" }, copy: { prefix: "p", runId: "r1", endedAt: "2026-11-09T10:00:00Z" }, marker: "p/.factory/RUN.json" }]) });
  setup({ core, storage, copyReadiness: async (fs, prefix, runId) => { copies.push(runId); return false; } });
  await settle();
  assert.equal(world.records.length, 1);
  assert.equal(copies.length, 1);
  assert.ok(posts.length <= 1);
  assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
});

test("log lines are coalesced into one notification, reads are never stale, and a state change absorbs the pending one", async () => {
  let log;
  setup({ runLoop: (_config, deps) => { log = deps.log; const g = deferred(); world.gates.set(deps.__runId, g); return g.promise; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  let notes = 0;
  const off = rm.subscribe(() => { notes += 1; });
  for (let i = 0; i < 20; i++) log(`line ${i}`);
  assert.equal(notes, 0, "no notification per line");
  assert.equal(rm.liveRuns()[0].log.at(-1), "line 19", "a read sees every line appended so far");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(notes, 1, "one notification for the burst");
  log("tail");
  rm.setRunNote(a, "n");
  assert.equal(notes, 2, "a state change notifies at once");
  assert.equal(rm.liveRuns()[0].log.at(-1), "tail");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(notes, 2, "the pending log notification was absorbed");
  off();
  await finish(a);
});

test("a record that cannot be written is held with its marker, announced, and not replayed", async () => {
  const storage = memoryStorage();
  const marks = [];
  setup({ storage, fsFor: markerFs(marks), appendRecord: async () => { throw new Error("cannot resolve parent folder"); } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  const marker = "system/loop-worktrees/" + a + "/.factory/RUN.json";
  const held = JSON.parse(storage.getItem("llmide.factory.pendingRecords"));
  assert.equal(held.length, 1);
  assert.equal(held[0].marker, marker);
  assert.equal(held[0].record.worktree.runId, a);
  assert.equal(held[0].markerOnly, undefined);
  assert.match(rm.takeRunNotice(), /Run record not written: cannot resolve parent folder/);
  assert.equal(rm.liveRuns().length, 0);
  // storedPendingRunIds (auto-resume) reads record.worktree.runId, asserted above, so the run is not replayed
  // the next launch retries it and clears the marker
  const after = [];
  setup({ storage, fsFor: markerFs(after) });
  await settle();
  assert.equal(world.records.length, 1);
  assert.deepEqual(after.filter(([k]) => k === "remove").map(([, p]) => p), [marker]);
  assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
});

const LOGS = "system/loop-runs/logs";
// A project fs for the run log: files in a map, directories tolerated, list/remove for the pruning.
function logFs(files, opts = {}) {
  const writes = [];
  const api = {
    writes,
    write: async (path, text, o) => {
      if (path.endsWith(".log")) {
        if (opts.hang) return new Promise(() => {});
        if (opts.fail) throw new Error("disk full");
      }
      writes.push({ path, text, opts: o });
      files.set(path, text);
    },
    remove: async (path) => { files.delete(path); },
    create: async () => "dir",
    read: async (path) => { if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "not_found" }); return { status: "ok", text: files.get(path), hash: "h" }; },
    list: async (dir) => ({ entries: [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => ({ name: k.slice(dir.length + 1), path: k, mtime_ms: opts.mtimes?.get(k) ?? 0 })) }),
  };
  return () => api;
}
const lastLog = (api) => api.writes.filter((w) => w.path.endsWith(".log")).pop();

test("run log lines are written to the project's loop-runs/logs and survive the run", async () => {
  const files = new Map();
  const fsf = logFs(files);
  setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("$ npm test"); deps.log("FAIL one"); return PASSED; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  const last = lastLog(fsf());
  assert.equal(last.path, `${LOGS}/${a}.log`);
  assert.match(last.text, /\$ npm test\nFAIL one/);
  assert.equal(last.opts.force, true);
  assert.equal([...files.keys()].some((k) => k.includes(".factory/run.log")), false);
});

test("a failing run.log write never changes the run's outcome", async () => {
  const fsf = logFs(new Map(), { fail: true });
  setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("hello"); return PASSED; } });
  rm.startRun("/p", item(1), "full");
  await settle();
  assert.equal(world.records.length, 1);
  assert.equal(world.records[0].record.statusCode, "success");
});

test("run.log keeps only the last 256 KiB, counted in bytes", async () => {
  const fsf = logFs(new Map());
  setup({ fsFor: fsf, runLoop: async (config, deps) => { for (let i = 0; i < 100; i++) deps.log(`行${i} ` + "あ".repeat(3000)); return PASSED; } });
  rm.startRun("/p", item(1), "full");
  await settle();
  const last = lastLog(fsf());
  assert.ok(new TextEncoder().encode(last.text).length <= 256 * 1024);
  assert.match(last.text, /行99 /);
  assert.doesNotMatch(last.text, /行0 /);
});

test("a resumed run appends to its log after a separator", async () => {
  const files = new Map();
  const fsf = logFs(files);
  setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("first run line"); return PASSED; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("second run line"); return PASSED; } });
  world.list = [{ runId: a, project: "/p", repo: "/p", worktree: `/p/system/loop-worktrees/${a}`, branch: "b", baseCommit: "abc1234def" }];
  rm.startRun("/p", item(1), "sendBack", { runId: a });
  await settle();
  const text = files.get(`${LOGS}/${a}.log`);
  assert.match(text, /first run line\n(.*\n)*--- resumed \d{4}-\d{2}-\d{2}T[\d:.]+Z ---\n(.*\n)*second run line/);
});

test("only the newest 50 run logs are kept, by modification time", async () => {
  const files = new Map();
  const mtimes = new Map();
  // Names run oldest to newest, but the OLDEST-named log was written to most recently (a resumed run).
  for (let i = 0; i < 60; i++) { const path = `${LOGS}/20260101-0000${String(i).padStart(2, "0")}-aaaaaa.log`; files.set(path, "x"); mtimes.set(path, 1000 + i); }
  mtimes.set(`${LOGS}/20260101-000000-aaaaaa.log`, 999999);
  const fsf = logFs(files, { mtimes });
  setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("l"); return PASSED; } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  const logs = [...files.keys()].filter((k) => k.endsWith(".log"));
  assert.ok(logs.length <= 50, `kept ${logs.length}`);
  assert.ok(files.has(`${LOGS}/${a}.log`));
  assert.ok(files.has(`${LOGS}/20260101-000000-aaaaaa.log`), "the recently written old-named log stays");
  assert.equal(files.has(`${LOGS}/20260101-000001-aaaaaa.log`), false, "the least recently written goes first");
});

test("the debounce writes the log during the run, not only at the end", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fsf = logFs(new Map());
    let release;
    setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("midway"); await new Promise((r) => { release = r; }); return PASSED; } });
    rm.startRun("/p", item(1), "full");
    await settle();
    assert.equal(lastLog(fsf()), undefined, "nothing before the debounce");
    mock.timers.tick(1000);
    await settle();
    assert.match(lastLog(fsf()).text, /midway/);
    release();
    await settle();
  } finally { mock.timers.reset(); }
});

test("a stalled log write cannot keep a finished run live", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const fsf = logFs(new Map(), { hang: true });
    setup({ fsFor: fsf, runLoop: async (config, deps) => { deps.log("x"); return PASSED; } });
    rm.startRun("/p", item(1), "full");
    await settle();
    mock.timers.tick(6000);
    await settle();
    assert.equal(rm.liveRuns().length, 0);
  } finally { mock.timers.reset(); }
});

test("a held record that keeps failing posts a notice each time and says so after 5 tries, and stays stored", async () => {
  const storage = memoryStorage();
  {
    setup({ storage, fsFor: markerFs([]), appendRecord: async () => { throw new Error("disk"); } });
    const a = rm.startRun("/p", item(1), "full");
    await settle();
    await finish(a);
    assert.match(rm.takeRunNotice(), /Run record not written: disk/);
    for (let n = 2; n <= 4; n++) { await switchProject("/p"); assert.match(rm.takeRunNotice(), new RegExp(`attempt ${n}.*disk`)); }
    await switchProject("/p");
    assert.match(rm.takeRunNotice(), /could not be written after 5 tries.*disk/);
    const held = JSON.parse(storage.getItem("llmide.factory.pendingRecords"));
    assert.equal(held.length, 1);
    assert.equal(held[0].attempts, 5);
  }
  rm.resetRunManagerForTests(); // drops the retry timer so it cannot outlive the test
});

test("a held record is retried a few seconds later while the project stays open", async () => {
  const storage = memoryStorage();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let fail = true;
    const marks = [];
    setup({ storage, fsFor: markerFs(marks), appendRecord: async (fs, entry, record) => { if (fail) throw new Error("conflict"); world.records.push({ entry, record }); } });
    const a = rm.startRun("/p", item(1), "full");
    await settle();
    await finish(a);
    assert.equal(world.records.length, 0);
    fail = false;
    mock.timers.tick(5000);
    await settle();
    assert.equal(world.records.length, 1);
    assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
    assert.deepEqual(marks.filter(([k]) => k === "remove").map(([, p]) => p), ["system/loop-worktrees/" + a + "/.factory/RUN.json"]);
    assert.deepEqual(rm.heldRunIds("/p").size, 0);
  } finally { mock.timers.reset(); }
});

test("heldRunIds names the runs whose record is waiting, for the board", async () => {
  setup({ fsFor: markerFs([]), appendRecord: async () => { throw new Error("disk"); } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.deepEqual([...rm.heldRunIds("/p")], [a]);
  assert.equal(rm.heldRunIds("/other").size, 0);
});

test("a record stuck after the last try is reported by stuckRunIds, and retryHeldRecords writes it", async () => {
  const storage = memoryStorage();
  let fail = true;
  setup({ storage, fsFor: markerFs([]), appendRecord: async (fs, entry, record) => { if (fail) throw new Error("disk"); world.records.push({ entry, record }); } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  assert.equal(rm.stuckRunIds("/p").size, 0);
  for (let n = 2; n <= 5; n++) await switchProject("/p");
  assert.deepEqual([...rm.stuckRunIds("/p")], [a]);
  fail = false;
  await rm.retryHeldRecords("/p");
  assert.equal(world.records.length, 1);
  assert.equal(rm.heldRunIds("/p").size, 0);
  rm.resetRunManagerForTests();
});

test("dropHeldRecords forgets a held record in memory and storage", async () => {
  const storage = memoryStorage();
  setup({ storage, fsFor: markerFs([]), appendRecord: async () => { throw new Error("disk"); } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  rm.dropHeldRecords("/p", [a]);
  assert.equal(rm.heldRunIds("/p").size, 0);
  assert.deepEqual(JSON.parse(storage.getItem("llmide.factory.pendingRecords")), []);
  rm.takeRunNotice();
  await switchProject("/p");
  assert.equal(rm.takeRunNotice(), null, "no retry, no notice");
  rm.resetRunManagerForTests();
});

test("startRun with a runId whose record is still held is refused with a notice", async () => {
  setup({ fsFor: markerFs([]), appendRecord: async () => { throw new Error("disk"); } });
  const a = rm.startRun("/p", item(1), "full");
  await settle();
  await finish(a);
  rm.takeRunNotice();
  world.list = [{ runId: a, project: "/p", repo: "/p", worktree: `/p/system/loop-worktrees/${a}`, branch: "b", baseCommit: "abc" }];
  rm.startRun("/p", item(1), "sendBack", { runId: a });
  await settle();
  assert.equal(rm.liveRuns().length, 0);
  assert.match(rm.takeRunNotice(), /record is still being saved/);
  rm.resetRunManagerForTests();
});
