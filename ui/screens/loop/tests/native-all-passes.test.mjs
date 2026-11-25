import { test } from "node:test";
import assert from "node:assert/strict";
import { runAllPasses, hasRealProgress } from "../native/all-passes.ts";
import { runNativeLoop } from "../native/runner.ts";
import { decodeConfig } from "../native/model.ts";
import { runCommandLines } from "../native/run-command.ts";

const stage = (id) => ({ id, name: id, kind: "shellCommand", order: 0, enabled: true, severity: "blocking", allowsRepair: true });
const config = (over = {}) => decodeConfig({ stages: [stage("s")], maxIterations: 1, maxRepairsPerStage: 1, stageDelaySeconds: 0, ...over });

/** `results[k]` is whether pass k+1's stage passes; `moved[k]` is whether pass k+1 changed real paths. */
function fake({ results = [], moved = [] }) {
  const st = { passes: 0, logs: [], progressCalls: 0 };
  const deps = {
    async runStage() { const ok = results[st.passes] ?? true; st.passes += 1; return { ok, output: ok ? "" : "red" }; },
    async repair() { return { ok: false, output: "no" }; },
    log() {},
    isCancelled: () => false,
  };
  const opts = {
    async checkpoint() { return `t${st.passes}`; },
    async progressed() { st.progressCalls += 1; return moved[st.passes - 1] ?? false; },
    log: (l) => st.logs.push(l),
  };
  return { st, deps, opts };
}

test("stops after a pass that made no progress", async () => {
  const { st, deps, opts } = fake({ moved: [true, false] });
  const out = await runAllPasses(config(), deps, opts);
  assert.equal(st.passes, 2);
  assert.equal(out.passed, true);
  assert.equal(out.stages.length, 2);
  assert.deepEqual(st.logs, ["Pass 2 of up to 3"]);
});

test("stops at the passes cap", async () => {
  const { st, deps, opts } = fake({ moved: [true, true, true, true] });
  const out = await runAllPasses(config({ maxPassesPerRun: 2 }), deps, opts);
  assert.equal(st.passes, 2);
  assert.equal(out.stages.length, 2);
  assert.equal(out.iterationsUsed, 2);
  assert.match(out.statusSummary, /\(2 passes\)/);
});

test("a failed pass ends the run and keeps the earlier passes' stages", async () => {
  const { st, deps, opts } = fake({ results: [true, false], moved: [true, true] });
  const out = await runAllPasses(config(), deps, opts);
  assert.equal(st.passes, 2);
  assert.equal(out.passed, false);
  assert.equal(out.failedStage?.id, "s");
  assert.equal(out.stages.length, 2);
  assert.equal(st.progressCalls, 1, "no progress check after a failed pass");
});

test("never gives a pass more than the remaining cost ceiling, and stops when it is spent", async () => {
  const seen = [];
  const { deps, opts } = fake({ moved: [true, true, true] });
  deps.runStage = async () => ({ ok: true, output: "", usage: { costUsd: 0.6 } });
  const real = deps.log;
  const out = await runAllPasses(config({ maxCostUsd: 1 }), { ...deps, log: real }, { ...opts, async progressed() { seen.push(1); return true; } });
  assert.equal(out.stages.length, 2, "pass 3 is not started with no ceiling left");
  assert.ok((out.costUsd ?? 0) <= 1.3);
  assert.match(out.statusSummary, /cost ceiling reached/);
});

test("a single pass behaves exactly like runNativeLoop", async () => {
  const a = fake({ moved: [true] });
  const b = fake({});
  const one = await runAllPasses(config({ maxPassesPerRun: 1 }), a.deps, a.opts);
  const plain = await runNativeLoop(config(), b.deps);
  assert.deepEqual(one, plain);
  assert.equal(a.st.progressCalls, 0);
});

test("a held or cancelled pass is returned at once", async () => {
  const { st, deps, opts } = fake({ moved: [true, true] });
  deps.isCancelled = () => st.passes >= 1;
  const out = await runAllPasses(config(), deps, opts);
  assert.equal(out.cancelled, true);
  assert.equal(st.passes, 1);
});

test("only paths outside the loop's own folders count as progress", () => {
  assert.equal(hasRealProgress([]), false);
  assert.equal(hasRealProgress(["system/loop/ledger.json", "system/loop-runs/a.md", "system/loop-worktrees/x/y", "llm-doc/loop/runs/r.md", "llm-doc/loop/test/TEST-MAP.md", ".factory/PLAN.md"]), false);
  assert.equal(hasRealProgress(["llm-doc/loop/docs/a.md"]), true);
  assert.equal(hasRealProgress(["llm-doc/loop/plan/PLAN.md"]), true);
  assert.equal(hasRealProgress(["system/loop/a", "src/a.ts"]), true);
  assert.equal(hasRealProgress(["system/loops.md"]), true);
  assert.equal(hasRealProgress(["llm-doc/loopy/a.md"]), true);
});

test("the run command wording is pinned and empty text adds nothing", () => {
  assert.deepEqual(runCommandLines("  fix the login bug "), ["This run's task, given by the user: fix the login bug", "Do only this one item and then stop. Do not pick any other item."]);
  assert.deepEqual(runCommandLines(undefined), []);
  assert.deepEqual(runCommandLines("   "), []);
});

test("the dependency install runs once per run, not once per pass", async () => {
  const ran = [];
  const deps = { async runStage(s) { ran.push(s.id); return { ok: true, output: "" }; }, async repair() { return { ok: false, output: "no" }; }, log() {}, isCancelled: () => false };
  const opts = { async checkpoint() { return "t"; }, async progressed() { return true; }, log() {} };
  const setup = "loop/setup-x";
  await runAllPasses(config({ stages: [stage(setup), stage("s")], maxPassesPerRun: 3 }), deps, opts);
  assert.deepEqual(ran, [setup, "s", "s", "s"]);
});
