import { test } from "node:test";
import assert from "node:assert/strict";
import { createStageDeps } from "../native/stage-exec.ts";
import { runNativeLoop } from "../native/runner.ts";

const stage = (over = {}) => ({
  id: "s1", name: "Stage", kind: "shellCommand", command: "npm test", order: 0, skillId: null, targetPath: null,
  outputPath: null, prompt: null, isDefault: false, enabled: true, defaultKey: null, severity: "blocking",
  timeoutSeconds: null, detectedCommand: null, check: null, testOp: null, graphOp: null, allowsRepair: true,
  defaultRevision: null, disabledByDetection: null, raw: null, ...over,
});
const loopOf = (stages) => ({
  id: "L1", name: "Factory", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "factory",
  runsOnSchedule: false,
  config: {
    stages, maxIterations: 3, consecutiveFailureStop: 2, wallClockBudgetSeconds: null, pauseTimeoutSeconds: 0,
    maxRepairsPerStage: 2, repairModel: null, protectedPathPolicy: "revert", writeSummaryNote: false,
    extraProtectedGlobs: [], useWorktreesForConcurrentRuns: false, alwaysUseWorktree: true, openMergeRequest: true,
    refactorBatchesPerRun: null,
  },
});

/** Records every host command; `answers[command]` is the reply (a function gets the args). */
function fakeHost(answers = {}) {
  const calls = [];
  const host = async (command, args) => {
    calls.push([command, args]);
    const answer = answers[command];
    if (typeof answer === "function") return answer(args);
    if (answer !== undefined) return answer;
    if (command === "loop_changed_paths") return [];
    return null;
  };
  return { host, calls };
}

function fakeCore(reply) {
  const calls = [];
  return { calls, core: { async request(path, opts) { calls.push([path, opts]); return reply; } } };
}

/** Project-relative in-memory files; a missing path throws like the host (`not_found`). */
function fakeFs(files = {}) {
  const reads = [];
  return {
    reads,
    fs: {
      async read(path) {
        reads.push(path);
        if (!(path in files)) throw Object.assign(new Error(`not found: ${path}`), { code: "not_found" });
        return { status: "ok", text: files[path], hash: "h" };
      },
      async list() { return { entries: [] }; },
    },
  };
}

function ctxOf(over = {}) {
  const log = [];
  let cancelled = false;
  const ctx = {
    projectRoot: "/p", runId: "r1", runRoot: "/p/system/loop-worktrees/r1",
    fs: fakeFs().fs, host: fakeHost().host, core: fakeCore({}).core,
    log: (line) => { log.push(line); },
    approvalToken: async () => "tok",
    isCancelled: () => cancelled,
    markCancelled: () => { cancelled = true; },
    ...over,
  };
  return { ctx, log };
}

test("createStageDeps runs a shellCommand stage through loop_run_stage with runId", async () => {
  const { host, calls } = fakeHost({ loop_run_stage: { exitCode: 0, stdout: "ok", stderr: "", timedOut: false } });
  const { ctx, log } = ctxOf({ host });
  const s = stage({ timeoutSeconds: 60 });
  const deps = createStageDeps(ctx, loopOf([s]));
  assert.deepEqual(await deps.runStage(s, []), { ok: true, output: "ok" });
  assert.deepEqual(calls, [["loop_run_stage", { stageId: "s1", loopId: "L1", approvalToken: "tok", timeoutSecs: 60, runId: "r1" }]]);
  assert.deepEqual(log, ["$ Stage", "ok", ""]);
  assert.equal(deps.halt(), null);
  assert.equal(deps.haltIsError(), false);
});

test("a run without a run id sends no runId and a cancelled shell stage marks the run cancelled", async () => {
  const { host, calls } = fakeHost({ loop_run_stage: { exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true } });
  const { ctx } = ctxOf({ host, runId: null, runRoot: "/p" });
  const s = stage();
  assert.deepEqual(await createStageDeps(ctx, loopOf([s])).runStage(s, []), { ok: false, output: "Stage cancelled." });
  assert.deepEqual(calls[0], ["loop_run_stage", { stageId: "s1", loopId: "L1", approvalToken: "tok", timeoutSecs: null }]);
  assert.equal(ctx.isCancelled(), true);
});

test("createStageDeps sends repoRoot = runRoot and writeScope for skill stages that declare it", async () => {
  const { host, calls: hostCalls } = fakeHost();
  const { core, calls } = fakeCore({ reply: "wrote the report", resultSubtype: "success", changedPaths: [".factory/READINESS.md"], createdPaths: [".factory/READINESS.md"] });
  const { ctx } = ctxOf({ host, core });
  const intake = stage({ id: "s2", name: "Intake", kind: "skill", command: null, skillId: "skills/factory-intake", timeoutSeconds: 120 });
  const plan = stage({ id: "s3", name: "Plan", kind: "skill", command: null, skillId: "skills/writing-plans" });
  const deps = createStageDeps(ctx, loopOf([intake, plan]));
  assert.equal((await deps.runStage(intake, [])).ok, true);
  const [path, opts] = calls[0];
  assert.equal(path, "/kb/loop/agent-run");
  assert.equal(opts.method, "POST");
  const { message, ...rest } = opts.body;
  assert.match(message, /Run the Intake skill/);
  // PLAN DEVIATION: Phase A's agentRunBody also gives Intake the project's llm-doc/ as an extra read root when the
  // run root is not the project root (the split-layout case). The plan's reference body omitted it; the stage keeps
  // the real behaviour, so the exact body carries it here too.
  assert.deepEqual(rest, { skills: ["skills/factory-intake"], repoRoot: "/p/system/loop-worktrees/r1", timeoutMs: 120_000, writeScope: ".factory", extraRoots: ["/p/llm-doc"] });
  await deps.runStage(plan, []);
  assert.equal(calls[1][1].body.writeScope, ".factory", "Plan writes only its PLAN.md report");
  assert.equal(calls[1][1].body.repoRoot, "/p/system/loop-worktrees/r1");
  assert.deepEqual(hostCalls.filter(([c]) => c === "loop_changed_paths").map(([, a]) => a), [{ runId: "r1" }, { runId: "r1" }]);
  assert.equal(deps.halt(), null);
});

test("createStageDeps maps a verdict artifactCheck through the run root prefix", async () => {
  const gate = stage({ id: "g1", name: "Intake gate", kind: "artifactCheck", command: null, allowsRepair: false, check: { verdict: { path: ".factory/READINESS.md", line: "Verdict: ready" } } });
  const ready = fakeFs({ "system/loop-worktrees/r1/.factory/READINESS.md": "## Result\nVerdict: ready\n" });
  const { ctx } = ctxOf({ fs: ready.fs });
  assert.deepEqual(await createStageDeps(ctx, loopOf([gate])).runStage(gate, []), { ok: true, output: "Artifact check passed." });
  assert.ok(ready.reads.includes("system/loop-worktrees/r1/.factory/READINESS.md"));
  const undecided = fakeFs({ "system/loop-worktrees/r1/.factory/READINESS.md": "Verdict: needs-decision\n" });
  const { ctx: ctx2 } = ctxOf({ fs: undecided.fs });
  const failed = await createStageDeps(ctx2, loopOf([gate])).runStage(gate, []);
  assert.equal(failed.ok, false);
  assert.match(failed.output, /verdict line missing/);
});

test("a repair that writes a protected path is reverted with the run id and halts the run as blocked", async () => {
  const { host, calls } = fakeHost();
  const { core } = fakeCore({ reply: "deleted the failing test", resultSubtype: "success", changedPaths: ["src/a.test.ts"], createdPaths: [] });
  const { ctx, log } = ctxOf({ host, core });
  const s = stage();
  const deps = createStageDeps(ctx, loopOf([s]));
  const r = await deps.repair(s, "1 failing", 1);
  assert.equal(r.ok, false);
  assert.match(r.output, /protected path/);
  assert.deepEqual(calls.find(([c]) => c === "loop_revert_paths"), ["loop_revert_paths", { paths: ["src/a.test.ts"], created: [], runId: "r1" }]);
  assert.match(deps.halt(), /reverted.*; the run stopped$/);
  assert.equal(deps.haltIsError(), false);
  assert.equal(log[0], "↻ repair Stage");
  // A second createStageDeps has its own halt state.
  assert.equal(createStageDeps(ctx, loopOf([s])).halt(), null);
});

test("in a factory loop the Implement stage may write tests; a repair may not", async () => {
  const { host, calls } = fakeHost();
  const { core } = fakeCore({ reply: "wrote tests", resultSubtype: "success", changedPaths: ["tests/a.test.ts"], createdPaths: ["tests/a.test.ts"] });
  const { ctx } = ctxOf({ host, core });
  const implement = stage({ id: "s4", name: "Implement", kind: "skill", command: null, skillId: "skills/test-driven-development" });
  const deps = createStageDeps(ctx, loopOf([implement]));
  assert.equal((await deps.runStage(implement, [])).ok, true);
  assert.equal(calls.some(([c]) => c === "loop_revert_paths"), false, "Implement's own writes are exempt from the protected-path revert");
  assert.equal(deps.halt(), null);
  const r = await deps.repair(implement, "1 failing", 1);
  assert.equal(r.ok, false, "a repair is fully checked");
  assert.ok(calls.some(([c]) => c === "loop_revert_paths"));
});

test("A1: a skill stage with a .factory output clears that file before the agent runs", async () => {
  const order = [];
  const calls = [];
  const host = async (command, args) => {
    calls.push([command, args]);
    order.push(command);
    if (command === "loop_changed_paths") return [];
    if (command === "loop_worktree_diff") return { text: "", truncated: false };
    if (command === "loop_clear_factory_output") return null;
    return null;
  };
  const core = {
    async request() {
      order.push("agent-run");
      return { reply: "wrote it", resultSubtype: "success", changedPaths: [".factory/REVIEW.md"], createdPaths: [] };
    },
  };
  const { ctx } = ctxOf({ host, core });
  const review = stage({ id: "s7", name: "Review", kind: "skill", command: null, skillId: "skills/factory-review", outputPath: ".factory/REVIEW.md" });
  const r = await createStageDeps(ctx, loopOf([review])).runStage(review, []);
  assert.equal(r.ok, true);
  assert.equal(order[0], "loop_clear_factory_output", "the stale report is removed first");
  assert.ok(order.indexOf("loop_clear_factory_output") < order.indexOf("agent-run"), "the stale report is removed before the agent call");
  assert.deepEqual(calls.find(([c]) => c === "loop_clear_factory_output"), ["loop_clear_factory_output", { path: ".factory/REVIEW.md", runId: "r1" }]);
});

test("A1: a stage whose .factory output the agent did not write fails even when the agent run succeeded", async () => {
  const { host } = fakeHost({ loop_clear_factory_output: null, loop_worktree_diff: { text: "", truncated: false } });
  const { core } = fakeCore({ reply: "nothing to do", resultSubtype: "success", changedPaths: ["src/a.ts"], createdPaths: [] });
  const { ctx } = ctxOf({ host, core });
  const review = stage({ id: "s7", name: "Review", kind: "skill", command: null, skillId: "skills/factory-review", outputPath: ".factory/REVIEW.md" });
  const deps = createStageDeps(ctx, loopOf([review]));
  const r = await deps.runStage(review, []);
  assert.equal(r.ok, false);
  assert.match(r.output, /report was not written: \.factory\/REVIEW\.md/);
  assert.equal(deps.halt(), null, "a missing report is a stage failure, not a run halt");
});

test("A1: send-back Review with a stale approve report fails and never reaches the review gate", async () => {
  const { runNativeLoop } = await import("../native/runner.ts");
  const { configFor } = await import("../native/factory.ts");
  const files = { "system/loop-worktrees/r1/.factory/REVIEW.md": "old findings\nVerdict: approve\n" };
  const { fs } = fakeFs(files);
  const removals = [];
  const host = async (command, args) => {
    if (command === "loop_changed_paths") return [];
    if (command === "loop_clear_factory_output") { removals.push(args.path); delete files[`system/loop-worktrees/r1/${args.path}`]; return null; }
    return null;
  };
  const { core } = fakeCore({ reply: "done", resultSubtype: "success", changedPaths: ["src/a.ts"], createdPaths: [] });
  const { ctx } = ctxOf({ host, core, fs });
  const review = stage({ id: "s7", name: "Review", kind: "skill", command: null, skillId: "skills/factory-review", allowsRepair: false, outputPath: ".factory/REVIEW.md" });
  const gate = stage({ id: "g2", name: "Review gate", kind: "artifactCheck", command: null, allowsRepair: false, check: { verdict: { path: ".factory/REVIEW.md", line: "Verdict: approve" } } });
  const deps = createStageDeps(ctx, loopOf([review, gate]));
  const outcome = await runNativeLoop(configFor("sendBack", loopOf([review, gate]).config), { ...deps, log() {} });
  assert.deepEqual(removals, [".factory/REVIEW.md"]);
  assert.equal(outcome.passed, false);
  assert.equal(outcome.failedStage?.id, "s7", "Review failed before the gate ran");
  assert.deepEqual(outcome.stages.map((o) => o.stage.id), ["s7"]);
});

test("A1: a resumed Intake that writes nothing fails instead of passing on the old READINESS.md", async () => {
  const { host } = fakeHost({ loop_clear_factory_output: null });
  const { core } = fakeCore({ reply: "read only", resultSubtype: "success", changedPaths: [], createdPaths: [] });
  const { ctx } = ctxOf({ host, core });
  const intake = stage({ id: "s2", name: "Intake", kind: "skill", command: null, skillId: "skills/factory-intake", allowsRepair: false, outputPath: ".factory/READINESS.md" });
  const r = await createStageDeps(ctx, loopOf([intake])).runStage(intake, []);
  assert.equal(r.ok, false);
  assert.match(r.output, /report was not written: \.factory\/READINESS\.md/);
});

test("the Review stage prompt carries the worktree diff, read by run id, and a repair carries the factory hint", async () => {
  const { host, calls } = fakeHost({ loop_worktree_diff: { text: "+added line", truncated: false } });
  const { core, calls: coreCalls } = fakeCore({ reply: "ok", resultSubtype: "success", changedPaths: [".factory/REVIEW.md"], createdPaths: [] });
  const { ctx } = ctxOf({ host, core });
  const review = stage({ id: "s7", name: "Review", kind: "skill", command: null, skillId: "skills/factory-review" });
  const deps = createStageDeps(ctx, loopOf([review]));
  await deps.runStage(review, []);
  assert.deepEqual(calls.find(([c]) => c === "loop_worktree_diff"), ["loop_worktree_diff", { runId: "r1" }]);
  assert.match(coreCalls[0][1].body.message, /Diff of the worktree against HEAD/);
  assert.match(coreCalls[0][1].body.message, /\+added line/);
  await deps.repair(stage(), "1 failing", 1);
  assert.match(coreCalls[1][1].body.message, /This is a Factory run/);
  assert.equal(coreCalls[1][1].body.denyWrite, ".factory", "a Factory repair may not rewrite the reports it is judged by");
});

test("a repair outside a Factory loop sends no denyWrite", async () => {
  const { host } = fakeHost();
  const { core, calls } = fakeCore({ reply: "fixed", resultSubtype: "success", changedPaths: ["src/a.ts"], createdPaths: [] });
  const { ctx } = ctxOf({ host, core });
  const loop = { ...loopOf([stage()]), defaultKey: "regression" };
  await createStageDeps(ctx, loop).repair(stage(), "1 failing", 1);
  assert.equal("denyWrite" in calls[0][1].body, false);
});

test("the Refactor Structure stage discovers tests and writes both structure reports", async () => {
  const files = {
    "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    "tests/a.test.mjs": "import 'node:test';",
  };
  const writes = [];
  const fs = {
    async read(path) {
      if (!(path in files)) throw Object.assign(new Error("not found"), { code: "not_found" });
      return { status: "ok", text: files[path], hash: "h" };
    },
    async list(path) {
      if (path === ".") return { entries: [{ name: "tests", kind: "dir", path: "tests" }, { name: "package.json", kind: "file", path: "package.json" }] };
      if (path === "tests") return { entries: [{ name: "a.test.mjs", kind: "file", path: "tests/a.test.mjs" }] };
      throw Object.assign(new Error("not found"), { code: "not_found" });
    },
    async create() {},
    async write(path, text) { writes.push([path, text]); },
  };
  const { ctx } = ctxOf({ fs, projectRoot: "/p", runRoot: "/p" });
  const s = stage({ id: "refactor/refactor-structure", name: "Refactor Structure", kind: "testMap", command: null, testOp: "structure" });
  const r = await createStageDeps(ctx, loopOf([s])).runStage(s, []);
  assert.equal(r.ok, true);
  assert.match(r.output, /1 test root/);
  assert.deepEqual(writes.map(([p]) => p), ["llm-doc/loop/test/TEST-STRUCTURE.md", "system/loop/test/TEST-STRUCTURE.json"]);
});

/** `fakeFs` plus the write/create the Graph snapshot needs; writes are recorded in `writes`. */
function fakeWritableFs(files) {
  const writes = [];
  const base = fakeFs(files).fs;
  return { writes, fs: { ...base, async create() {}, async write(path, text) { writes.push([path, text]); } } };
}

test("a Graph snapshot in a worktree run writes its graph and before.json under the run's loop-runs folder", async () => {
  const graph = JSON.stringify({ nodes: [{ id: "file:a.ts", kind: "file" }], edges: [] });
  const { fs, writes } = fakeWritableFs({ "system/loop-runs/r1/graph/graph-code.json": graph });
  const { host, calls } = fakeHost({ graph_generate: { path: "system/loop-runs/r1/graph/graph-code.json", nodes: 1, edges: 0 } });
  const { ctx } = ctxOf({ host, fs });
  const s = stage({ id: "g1", name: "Graph", kind: "codeGraph", command: null, graphOp: "snapshot" });
  assert.equal((await createStageDeps(ctx, loopOf([s])).runStage(s, [])).ok, true);
  assert.deepEqual(calls.find(([c]) => c === "graph_generate"), ["graph_generate", { mode: "code", target: "system/loop-worktrees/r1", out: "system/loop-runs/r1/graph" }]);
  assert.deepEqual(writes, [["system/loop-runs/r1/graph/before.json", graph]]);
});

test("a Graph snapshot in a main-tree run sends no out and snapshots the project graph", async () => {
  const graph = JSON.stringify({ nodes: [{ id: "file:a.ts", kind: "file" }], edges: [] });
  const { fs, writes } = fakeWritableFs({ "system/graph/graph-code.json": graph });
  const { host, calls } = fakeHost({ graph_generate: { path: "system/graph/graph-code.json", nodes: 1, edges: 0 } });
  const { ctx } = ctxOf({ host, fs, runId: null, runRoot: "/p" });
  const s = stage({ id: "g1", name: "Graph", kind: "codeGraph", command: null, graphOp: "snapshot" });
  assert.equal((await createStageDeps(ctx, loopOf([s])).runStage(s, [])).ok, true);
  const args = calls.find(([c]) => c === "graph_generate")[1];
  assert.equal("out" in args, false, "the legacy run sends no out folder");
  assert.deepEqual(writes, [["system/loop/refactor/graph/before.json", graph]]);
});

test("a Test Map stage refreshes the run's graph into its worktree folder unless a Graph stage already ran in this run", async () => {
  const graph = JSON.stringify({ files: [{ path: "a.py", name: "a.py", loc: 2, functions: [{ name: "run", line: 1 }] }], calls: [] });
  const { fs } = fakeWritableFs({ "system/loop-runs/r1/graph/graph-code.json": graph });
  const { host, calls } = fakeHost();
  const { ctx } = ctxOf({ host, fs });
  const s = stage({ id: "t1", name: "Test Map", kind: "testMap", command: null, testOp: "map" });
  const r = await createStageDeps(ctx, loopOf([s])).runStage(s, []);
  assert.equal(r.ok, true);
  assert.deepEqual(calls.find(([c]) => c === "graph_generate"), ["graph_generate", { mode: "code", target: "system/loop-worktrees/r1", out: "system/loop-runs/r1/graph" }]);
  assert.match(r.output, /^1 function\(s\)/);

  const { host: host2, calls: calls2 } = fakeHost();
  const graphStage = stage({ id: "g1", name: "Graph", kind: "codeGraph", command: null, graphOp: "snapshot" });
  const prior = [{ stage: graphStage, ok: true, output: "" }];
  await createStageDeps(ctxOf({ host: host2, fs }).ctx, loopOf([s])).runStage(s, prior);
  assert.equal(calls2.some(([c]) => c === "graph_generate"), false, "a Graph stage earlier in the run already refreshed the graph");
});

test("a main-tree Test Map stage maps a fresh graph in its own folder and never rewrites the project graph", async () => {
  const graph = JSON.stringify({ files: [{ path: "a.py", name: "a.py", loc: 2, functions: [{ name: "run", line: 1 }] }], calls: [] });
  const { fs } = fakeWritableFs({ "system/loop-runs/main-tree/graph/graph-code.json": graph });
  const { host, calls } = fakeHost();
  const { ctx } = ctxOf({ host, fs, runId: null, runRoot: "/p" });
  const s = stage({ id: "t1", name: "Test Map", kind: "testMap", command: null, testOp: "map" });
  const r = await createStageDeps(ctx, loopOf([s])).runStage(s, []);
  const args = calls.find(([c]) => c === "graph_generate")[1];
  assert.equal(args.mode, "code");
  assert.equal(args.out, "system/loop-runs/main-tree/graph", "a multi-repo project's whole graph is left alone");
  assert.match(r.output, /^1 function\(s\)/, "the map reads the graph it just made");
});

test("a Test Map stage still maps when graph_generate throws, and logs that the graph was not refreshed", async () => {
  const { fs } = fakeWritableFs({ "system/loop-runs/r1/graph/graph-code.json": "not json" });
  const { host } = fakeHost({ graph_generate: () => { throw new Error("boom"); } });
  const { ctx, log } = ctxOf({ host, fs });
  const s = stage({ id: "t1", name: "Test Map", kind: "testMap", command: null, testOp: "map" });
  const r = await createStageDeps(ctx, loopOf([s])).runStage(s, []);
  assert.equal(r.ok, true);
  assert.match(r.output, /function\(s\)/);
  assert.ok(log.includes("graph not refreshed: boom; the map uses the last graph or file matching"), log.join("\n"));
});

test("R3: a stage that throws fails with its message, halts the run as an error, and no repair agent runs", async () => {
  const { ctx, log } = ctxOf();
  const odd = stage({ id: "x1", name: "Odd", kind: "unknownKind" });
  const deps = createStageDeps(ctx, loopOf([odd]));
  const r = await deps.runStage(odd, []);
  assert.equal(r.ok, false);
  assert.match(r.output, /^Odd failed: .*unknownKind/);
  assert.deepEqual(log.slice(0, 1), ["$ Odd"]);
  assert.match(deps.halt(), /^Odd failed: .*unknownKind stage.*; the run stopped$/);
  assert.equal(deps.haltIsError(), true);
  const loop = loopOf([odd]);
  let repairs = 0;
  const out = await runNativeLoop(loop.config, { ...createStageDeps(ctx, loop), repair: async () => { repairs += 1; return { ok: true, output: "" }; }, log() {} });
  assert.equal(repairs, 0, "an infrastructure error is not sent to the repair agent");
  assert.equal(out.errored, true);
  assert.equal(out.blocked, undefined);
});

test("R2: a test writer keeps a new test file, but an edited test or build config is reverted", async () => {
  const { host, calls } = fakeHost();
  const { core } = fakeCore({ reply: "wrote", resultSubtype: "success", changedPaths: ["tests/test_new.py", "tests/test_golden.py", "pyproject.toml"], createdPaths: ["tests/test_new.py"] });
  const { ctx } = ctxOf({ host, core });
  const loop = { ...loopOf([stage()]), defaultKey: "regression" };
  const writer = stage({ id: "g1", name: "Refactor Test Write", kind: "skill", command: null, skillId: "skills/test-gap-writer" });
  const deps = createStageDeps(ctx, loop);
  const r = await deps.runStage(writer, []);
  assert.equal(r.ok, false);
  assert.match(r.output, /tests\/test_golden\.py/);
  assert.deepEqual(calls.find(([c]) => c === "loop_revert_paths")[1].paths.sort(), ["pyproject.toml", "tests/test_golden.py"]);
  assert.equal(calls.find(([c]) => c === "loop_revert_paths")[1].paths.includes("tests/test_new.py"), false, "the new test file stays");
});

test("F4: a worktree run's test map reads its own graph snapshot, not the project's", async () => {
  const graph = JSON.stringify({ files: [{ path: "src/a.ts", name: "a.ts", loc: 2, functions: [{ name: "run", line: 1 }] }], calls: [] });
  const { fs, writes } = fakeWritableFs({ "system/loop-runs/r1/graph/graph-code.json": graph });
  const { ctx } = ctxOf({ fs });
  const s = stage({ id: "t1", name: "Test map", kind: "testMap", command: null, testOp: "map" });
  const r = await createStageDeps(ctx, loopOf([s])).runStage(s, []);
  assert.match(r.output, /^1 function\(s\)/, "the run's own graph supplies the function");
  assert.deepEqual(writes.map(([p]) => p), ["system/loop-worktrees/r1/llm-doc/loop/test/TEST-MAP.md", "system/loop-worktrees/r1/system/loop/test/TEST-MAP.json"]);
});

test("F5: a worktree run's artifact check does not accept a file that only exists in the main tree", async () => {
  const gate = stage({ id: "p1", name: "Refactor plan check", kind: "artifactCheck", command: null, allowsRepair: false, check: { requiredPaths: ["llm-doc/loop/refactor/REFACTOR.md"], projectRootFallback: true } });
  const mainOnly = fakeFs({ "llm-doc/loop/refactor/REFACTOR.md": "stale plan" });
  const { ctx } = ctxOf({ fs: mainOnly.fs });
  const r = await createStageDeps(ctx, loopOf([gate])).runStage(gate, []);
  assert.equal(r.ok, false);
  assert.match(r.output, /missing: llm-doc\/loop\/refactor\/REFACTOR\.md/);
  const inRun = fakeFs({ "system/loop-worktrees/r1/llm-doc/loop/refactor/REFACTOR.md": "plan" });
  const { ctx: ctx2 } = ctxOf({ fs: inRun.fs });
  assert.equal((await createStageDeps(ctx2, loopOf([gate])).runStage(gate, [])).ok, true);
});

test("F6: a non-factory test-writing stage keeps its own test files, but a repair is still judged on them", async () => {
  const { host, calls } = fakeHost();
  const { core } = fakeCore({ reply: "wrote the tests", resultSubtype: "success", changedPaths: ["tests/test_tax.py", "src/tax.py"], createdPaths: ["tests/test_tax.py"] });
  const { ctx } = ctxOf({ host, core });
  const loop = { ...loopOf([stage()]), defaultKey: "regression" };
  const gaps = stage({ id: "g1", name: "Test gaps", kind: "skill", command: null, skillId: "skills/test-gap-writer" });
  const deps = createStageDeps(ctx, loop);
  assert.equal((await deps.runStage(gaps, [])).ok, true);
  assert.equal(calls.some(([c]) => c === "loop_revert_paths"), false, "tests the stage wrote are its job, not a protected-path violation");
  assert.equal(deps.halt(), null);
  const r = await deps.repair(stage(), "1 failing", 1);
  assert.equal(r.ok, false, "a repair is judged on every path");
  assert.deepEqual(calls.find(([c]) => c === "loop_revert_paths"), ["loop_revert_paths", { paths: ["tests/test_tax.py"], created: ["tests/test_tax.py"], runId: "r1" }]);
});

test("F6: a test-writing stage may not touch CI files or the Loop's own data", async () => {
  const { host, calls } = fakeHost();
  const { core } = fakeCore({ reply: "edited", resultSubtype: "success", changedPaths: [".github/workflows/ci.yml", "system/loop.json"], createdPaths: [] });
  const { ctx } = ctxOf({ host, core });
  const loop = { ...loopOf([stage()]), defaultKey: "regression" };
  const refactor = stage({ id: "r1", name: "Refactor apply", kind: "skill", command: null, skillId: "skills/refactor-apply" });
  const deps = createStageDeps(ctx, loop);
  const r = await deps.runStage(refactor, []);
  assert.equal(r.ok, false);
  const reverted = calls.find(([c]) => c === "loop_revert_paths")[1].paths;
  assert.deepEqual(reverted.sort(), [".github/workflows/ci.yml", "system/loop.json"]);
});

test("the ledger stage passes without writing when the Test output has no per-test lines", async () => {
  const { host } = fakeHost();
  const { ctx } = ctxOf({ host, runId: null, runRoot: "/p" });
  const writes = [];
  ctx.fs = { ...fakeFs({}).fs, async write(path, text) { writes.push(path); }, async create() {} };
  const test = stage({ id: "t1", name: "Test", kind: "shellCommand", command: "pytest" });
  const ledger = stage({ id: "l1", name: "Ledger", kind: "testMap", command: null, testOp: "ledger" });
  const deps = createStageDeps(ctx, loopOf([test, ledger]));
  const r = await deps.runStage(ledger, [{ stage: test, ok: true, output: "3 tests, nothing to parse" }]);
  assert.equal(r.ok, true);
  assert.match(r.output, /no per-test results in the Test output/);
  assert.deepEqual(writes, []);
});

// A worktree refactor move may keep an existing test whose whole change is import lines (the worktree diff decides).
const importDiff = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-from old import a\n+from new import a\n`;
const bodyDiff = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,2 +1,2 @@\n-from old import a\n+from new import a\n-assert a() == 1\n+assert a() == 2\n`;
const moveRun = (over = {}) => {
  const loop = { ...loopOf([stage()]), defaultKey: "regression" };
  const apply = stage({ id: "r1", name: "Refactor apply", kind: "skill", command: null, skillId: "skills/refactor-apply" });
  const reply = { reply: "moved", resultSubtype: "success", changedPaths: ["tests/test_golden.py", "src/mod.py"], createdPaths: [] };
  return { loop, apply, reply, ...over };
};

// The worktree's plan, as the refactor-apply stage reads it: one batch in progress that names `files`.
const planFs = (files) => fakeFs({ "system/loop-worktrees/r1/llm-doc/loop/refactor/REFACTOR.md": `# Plan\n\n### R1 Move golden (status: todo)\n- Files: ${files}\n- Intent: move\n` }).fs;

test("an import move to a module the batch's plan does not name is reverted", async () => {
  const { loop, apply, reply } = moveRun();
  const { host, calls } = fakeHost({ loop_worktree_diff: { text: importDiff("tests/test_golden.py"), truncated: false } });
  const { ctx } = ctxOf({ host, core: fakeCore(reply).core, fs: planFs("`src/other.py`") });
  const r = await createStageDeps(ctx, loop).runStage(apply, []);
  assert.equal(r.ok, false);
  assert.ok(calls.find(([c]) => c === "loop_revert_paths")[1].paths.includes("tests/test_golden.py"));
});

test("a worktree refactor move keeps an existing test changed only by its import lines, and judges the rest", async () => {
  const { loop, apply, reply } = moveRun();
  const { host, calls } = fakeHost({ loop_worktree_diff: { text: importDiff("tests/test_golden.py"), truncated: false } });
  const { core } = fakeCore(reply);
  const { ctx, log } = ctxOf({ host, core, fs: planFs("`new.py`, `tests/test_golden.py`") });
  const deps = createStageDeps(ctx, loop);
  assert.equal((await deps.runStage(apply, [])).ok, true);
  assert.equal(calls.some(([c]) => c === "loop_revert_paths"), false, "the import-only test is not reverted");
  assert.deepEqual(calls.find(([c]) => c === "loop_worktree_diff")[1], { runId: "r1" });
  assert.ok(log.includes("kept import-only test edits: tests/test_golden.py"));
});

test("a worktree refactor move still reverts an existing test whose body changed", async () => {
  const { loop, apply, reply } = moveRun();
  const { host, calls } = fakeHost({ loop_worktree_diff: { text: bodyDiff("tests/test_golden.py"), truncated: false } });
  const { ctx } = ctxOf({ host, core: fakeCore(reply).core });
  const r = await createStageDeps(ctx, loop).runStage(apply, []);
  assert.equal(r.ok, false);
  assert.deepEqual(calls.find(([c]) => c === "loop_revert_paths")[1].paths, ["tests/test_golden.py"]);
});

test("a truncated worktree diff, or a host that throws reading it, keeps no test: the guard judges and reverts it", async () => {
  for (const diffAnswer of [{ text: importDiff("tests/test_golden.py"), truncated: true }, () => { throw new Error("diff gone"); }]) {
    const { loop, apply, reply } = moveRun();
    const { host, calls } = fakeHost({ loop_worktree_diff: diffAnswer });
    const { ctx } = ctxOf({ host, core: fakeCore(reply).core });
    const r = await createStageDeps(ctx, loop).runStage(apply, []);
    assert.equal(r.ok, false);
    assert.ok(calls.find(([c]) => c === "loop_revert_paths")[1].paths.includes("tests/test_golden.py"));
  }
});

test("a main-tree refactor move never reads the worktree diff and judges every test", async () => {
  const { loop, apply, reply } = moveRun();
  const { host, calls } = fakeHost({ loop_worktree_diff: { text: importDiff("tests/test_golden.py"), truncated: false } });
  const { ctx } = ctxOf({ host, core: fakeCore(reply).core, runId: null });
  const r = await createStageDeps(ctx, loop).runStage(apply, []);
  assert.equal(r.ok, false);
  assert.equal(calls.some(([c]) => c === "loop_worktree_diff"), false);
  assert.ok(calls.find(([c]) => c === "loop_revert_paths")[1].paths.includes("tests/test_golden.py"));
});

test("an apply agent that adds its own module to the plan's Files during the run still has the import move reverted", async () => {
  const { loop, apply, reply } = moveRun();
  const { host, calls } = fakeHost({ loop_worktree_diff: { text: importDiff("tests/test_golden.py"), truncated: false } });
  const planPath = "system/loop-worktrees/r1/llm-doc/loop/refactor/REFACTOR.md";
  let plan = "# Plan\n\n### R1 Move golden (status: todo)\n- Files: `src/other.py`\n- Intent: move\n";
  const fs = { ...planFs("`src/other.py`"), async read(p) { if (p !== planPath) throw Object.assign(new Error("missing"), { code: "not_found" }); return { status: "ok", text: plan }; } };
  // During its call the agent rewrites the plan: it names the module its test now imports and marks the batch done.
  const core = { async request() { plan = plan.replace("`src/other.py`", "`new.py`").replace("(status: todo)", "(status: done)"); return reply; } };
  const { ctx } = ctxOf({ host, core, fs });
  const r = await createStageDeps(ctx, loop).runStage(apply, []);
  assert.equal(r.ok, false, "the plan as it stood before the call decides");
  assert.ok(calls.find(([c]) => c === "loop_revert_paths")[1].paths.includes("tests/test_golden.py"));
});
