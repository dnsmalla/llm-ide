import { test } from "node:test";
import assert from "node:assert/strict";
import { createStageDeps } from "../native/stage-exec.ts";

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
  assert.equal("writeScope" in calls[1][1].body, false);
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
});
