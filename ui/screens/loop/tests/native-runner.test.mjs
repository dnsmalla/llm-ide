import { test } from "node:test";
import assert from "node:assert/strict";
import { runNativeLoop, runStatusCode } from "../native/runner.ts";
import { decodeConfig } from "../native/model.ts";

// stageDelaySeconds 0 keeps the existing tests off real timers; the pause tests below set it explicitly.
function cfg(stages, over = {}) { return decodeConfig({ stages, maxIterations: 3, maxRepairsPerStage: 2, consecutiveFailureStop: 3, stageDelaySeconds: 0, ...over }); }
const stage = (id, name, over = {}) => ({ id, name, kind: "shellCommand", order: 0, enabled: true, severity: "blocking", allowsRepair: true, ...over });

test("native runner passes when every blocking stage passes", async () => {
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")]), {
    async runStage() { return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
  });
  assert.equal(out.passed, true);
  assert.equal(out.iterationsUsed, 1);
  assert.equal(out.stages.length, 2);
});

test("native runner repairs a failing blocking stage and retries from the top", async () => {
  let runs = 0, repairs = 0;
  const out = await runNativeLoop(cfg([stage("a", "A")]), {
    async runStage() { runs += 1; return { ok: runs > 1, output: runs > 1 ? "" : "boom" }; },
    async repair() { repairs += 1; return { ok: true, output: "fixed" }; }, log() {},
  });
  assert.equal(out.passed, true);
  assert.equal(repairs, 1);
  assert.equal(out.iterationsUsed, 2);
});

test("native runner stops at the repair budget and ignores advisory failures", async () => {
  const out = await runNativeLoop(cfg([stage("a", "A")], { maxRepairsPerStage: 1 }), {
    async runStage() { return { ok: false, output: "same" }; },
    async repair() { return { ok: true, output: "tried" }; }, log() {},
  });
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /repair budget exhausted/);
  const advisory = await runNativeLoop(cfg([stage("a", "A", { severity: "advisory" })]), {
    async runStage() { return { ok: false, output: "lint" }; }, async repair() { throw new Error("no"); }, log() {},
  });
  assert.equal(advisory.passed, true);
});

test("native runner stops at the wall-clock budget", async () => {
  const out = await runNativeLoop(cfg([stage("a", "A")], { wallClockBudgetSeconds: 0.001, maxIterations: 3 }), {
    async runStage() { await new Promise((r) => setTimeout(r, 5)); return { ok: false, output: "no" }; },
    async repair() { return { ok: true, output: "fixed" }; }, log() {},
  });
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /wall-clock/);
});

test("native runner records cancellation instead of throwing", async () => {
  const out = await runNativeLoop(cfg([stage("a", "A")]), {
    async runStage() { throw new Error("should not run"); },
    async repair() { throw new Error("no"); }, log() {}, isCancelled() { return true; },
  });
  assert.equal(out.cancelled, true);
  assert.equal(out.passed, false);
});

test("a halt ends the run as a failure that is not a cancel, and no further stage runs", async () => {
  let ran = 0;
  let halted = false;
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")]), {
    async runStage() { ran += 1; halted = true; return { ok: true, output: "edited" }; },
    async repair() { throw new Error("no repair after a halt"); }, log() {},
    halt() { return halted ? "agent edit left in place; the run stopped" : null; },
  });
  assert.equal(out.passed, false);
  assert.equal(out.cancelled, undefined);
  assert.equal(out.statusSummary, "agent edit left in place; the run stopped");
  assert.equal(ran, 1);
});

test("a pause that outlasts its timeout aborts the run as cancelled and no further stage runs", async () => {
  let ran = 0;
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { pauseTimeoutSeconds: 60 }), {
    async runStage() { ran += 1; return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
    async holdWhilePaused(timeoutSeconds) { assert.equal(timeoutSeconds, 60); return "timedOut"; },
  });
  assert.equal(out.cancelled, true);
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /pause timed out/);
  assert.equal(ran, 0);
});

test("paused time does not count toward the wall-clock budget", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  let ran = 0;
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { wallClockBudgetSeconds: 2 }), {
    async runStage() { ran += 1; return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
    async holdWhilePaused() { now += 5_000; return "ok"; },
  });
  assert.equal(out.passed, true);
  assert.equal(ran, 2);
});

test("time outside a pause still ends the run at the budget", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { wallClockBudgetSeconds: 2 }), {
    async runStage() { now += 3_000; return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
    async holdWhilePaused() { return "ok"; },
  });
  assert.equal(out.passed, false);
  assert.equal(out.statusSummary, "wall-clock budget reached");
});

test("a passed runOnce stage is not re-run after a repair", async () => {
  const calls = [];
  const logs = [];
  let bRuns = 0;
  const out = await runNativeLoop(cfg([stage("a", "A", { runOnce: true }), stage("b", "B")]), {
    async runStage(s) {
      calls.push(s.name);
      if (s.id !== "b") return { ok: true, output: "" };
      bRuns += 1;
      return { ok: bRuns > 1, output: bRuns > 1 ? "" : "boom" };
    },
    async repair() { return { ok: true, output: "fixed" }; },
    log(line) { logs.push(line); },
  });
  assert.deepEqual(calls, ["A", "B", "B"]);
  assert.equal(out.passed, true);
  assert.equal(out.iterationsUsed, 2);
  assert.equal(out.stages.length, 3, "a skipped stage adds no outcome");
  assert.ok(logs.includes("↷ A: passed earlier in this run"), logs.join("\n"));
});

test("a failed runOnce stage is re-run in the next iteration", async () => {
  const calls = [];
  let aRuns = 0;
  const out = await runNativeLoop(cfg([stage("a", "A", { runOnce: true })]), {
    async runStage(s) { calls.push(s.name); aRuns += 1; return { ok: aRuns > 1, output: aRuns > 1 ? "" : "boom" }; },
    async repair() { return { ok: true, output: "fixed" }; }, log() {},
  });
  assert.deepEqual(calls, ["A", "A"]);
  assert.equal(out.passed, true);
});

test("native runner stops at the per-run USD ceiling and keeps the spent amount", async () => {
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { maxCostUsd: 1 }), {
    async runStage() { return { ok: true, output: "", usage: { costUsd: 1.25 } }; },
    async repair() { throw new Error("no repair"); }, log() {},
  });
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /cost ceiling/);
  assert.equal(out.costUsd, 1.25);
  assert.equal(out.stages.length, 1, "it stops before the next stage");
});

test("repairs count toward the USD ceiling", async () => {
  const out = await runNativeLoop(cfg([stage("a", "A")], { maxCostUsd: 5 }), {
    async runStage() { return { ok: false, output: "boom", usage: { costUsd: 0.1 } }; },
    async repair() { return { ok: true, output: "fixed", usage: { costUsd: 6 } }; }, log() {},
  });
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /cost ceiling/);
  assert.equal(out.costUsd, 6.1);
});

test("onProgress reports iteration, stage start/result and repair", async () => {
  const events = [];
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")]), {
    async runStage(s) { return { ok: s.id !== "a" || events.some(([t]) => t === "repair"), output: "" }; },
    async repair(s, _o, attempt) { events.push(["repair", s.id, attempt]); return { ok: true, output: "fixed" }; },
    log() {}, onProgress(e) { events.push([e.type, e.iteration ?? null, e.stage?.id ?? null, e.index ?? null, e.count ?? null]); },
  });
  assert.equal(out.passed, true);
  assert.deepEqual(events.slice(0, 4), [
    ["iteration", 1, null, null, null],
    ["stage-start", 1, "a", 1, 2],
    ["stage-result", 1, "a", null, null],
    ["repair", null, "a", null, null],
  ]);
  assert.ok(events.some(([t, , id]) => t === "stage-start" && id === "b"));
});

test("R1: a failed Test after an apply skill loops back to Apply (no repair agent); the snapshot stage still runs once", async () => {
  const calls = [];
  let tests = 0;
  const snapshot = stage("snap", "Snapshot", { kind: "codeGraph", graphOp: "snapshot" });
  const apply = stage("apply", "Apply", { kind: "skill", skillId: "skills/refactor-apply" });
  const unitTest = stage("t", "Test");
  const out = await runNativeLoop(cfg([snapshot, apply, unitTest]), {
    async runStage(s) {
      calls.push(s.name);
      if (s.id !== "t") return { ok: true, output: "" };
      tests += 1;
      return { ok: tests > 1, output: tests > 1 ? "" : "boom" };
    },
    async repair(s) { calls.push(`repair ${s.name}`); return { ok: true, output: "fixed" }; }, log() {},
  });
  assert.deepEqual(calls, ["Snapshot", "Apply", "Test", "Apply", "Test"]);
  assert.equal(out.passed, true);
  assert.equal(out.iterationsUsed, 2);
});

test("R6: a stage with no allowsRepair field is repairable; only an explicit false disables repair", async () => {
  const { allowsRepair, ...bare } = stage("a", "A");
  let runs = 0, repairs = 0;
  const out = await runNativeLoop({ ...cfg([stage("x", "X")]), stages: [bare] }, {
    async runStage() { runs += 1; return { ok: runs > 1, output: runs > 1 ? "" : "boom" }; },
    async repair() { repairs += 1; return { ok: true, output: "fixed" }; }, log() {},
  });
  assert.equal(out.passed, true);
  assert.equal(repairs, 1, "an in-memory template stage is repaired");
  const disabled = await runNativeLoop({ ...cfg([stage("x", "X")]), stages: [stage("a", "A", { allowsRepair: false })] }, {
    async runStage() { return { ok: false, output: "boom" }; }, async repair() { throw new Error("no repair"); }, log() {},
  });
  assert.match(disabled.statusSummary, /repair is disabled/);
});

test("the pause sits between stages: a 3-stage passing run sleeps twice, never before the first or after the last", async () => {
  const sleeps = [];
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B"), stage("c", "C")], { stageDelaySeconds: 2 }), {
    async runStage() { return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
    async sleep(ms) { sleeps.push(ms); },
  });
  assert.equal(out.passed, true);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test("a zero pause never sleeps", async () => {
  const sleeps = [];
  await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { stageDelaySeconds: 0 }), {
    async runStage() { return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
    async sleep(ms) { sleeps.push(ms); },
  });
  assert.deepEqual(sleeps, []);
});

test("a repair runs at once after a failed stage; the re-run from the top waits first", async () => {
  const events = [];
  let runs = 0;
  const out = await runNativeLoop(cfg([stage("a", "A")], { stageDelaySeconds: 2 }), {
    async runStage(s) { runs += 1; events.push(`run:${s.id}`); return { ok: runs > 1, output: runs > 1 ? "" : "boom" }; },
    async repair() { events.push("repair"); return { ok: true, output: "fixed" }; }, log() {},
    async sleep(ms) { events.push(`sleep:${ms}`); },
  });
  assert.equal(out.passed, true);
  assert.deepEqual(events, ["run:a", "repair", "sleep:2000", "run:a"]);
});

test("a stage skipped by runsOncePerRun adds no pause of its own", async () => {
  const sleeps = [];
  let bRuns = 0;
  const out = await runNativeLoop(cfg([stage("a", "A", { runOnce: true }), stage("b", "B")], { stageDelaySeconds: 2 }), {
    async runStage(s) { if (s.id !== "b") return { ok: true, output: "" }; bRuns += 1; return { ok: bRuns > 1, output: bRuns > 1 ? "" : "boom" }; },
    async repair() { return { ok: true, output: "fixed" }; }, log() {},
    async sleep(ms) { sleeps.push(ms); },
  });
  assert.equal(out.passed, true);
  assert.deepEqual(sleeps, [2000, 2000], "one before b, and one before b's re-run after the repair; a's skip adds none");
});

test("no pause is taken once the run is cancelled or halted", async () => {
  const sleeps = [];
  const cancelled = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { stageDelaySeconds: 2 }), {
    async runStage() { return { ok: true, output: "" }; }, async repair() { throw new Error("no"); }, log() {},
    isCancelled() { return true; }, async sleep(ms) { sleeps.push(ms); },
  });
  assert.equal(cancelled.cancelled, true);
  let ran = 0;
  const halted = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { stageDelaySeconds: 2 }), {
    async runStage() { ran += 1; return { ok: true, output: "" }; }, async repair() { throw new Error("no"); }, log() {},
    halt() { return ran > 0 ? "stopped" : null; }, async sleep(ms) { sleeps.push(ms); },
  });
  assert.equal(halted.statusSummary, "stopped");
  assert.equal(ran, 1);
  assert.deepEqual(sleeps, []);
});

test("the default pause returns promptly when Stop arrives during it", async () => {
  let flag = false;
  const ran = [];
  const started = Date.now();
  const out = await runNativeLoop(cfg([stage("a", "A"), stage("b", "B")], { stageDelaySeconds: 5 }), {
    async runStage(s) { ran.push(s.id); setTimeout(() => { flag = true; }, 200); return { ok: true, output: "" }; },
    async repair() { throw new Error("no"); }, log() {}, isCancelled() { return flag; },
  });
  const elapsed = Date.now() - started;
  assert.equal(out.cancelled, true);
  assert.deepEqual(ran, ["a"]);
  assert.ok(elapsed < 2000, `the 5 s pause ended after ${elapsed} ms`);
});

test("a halt raised while the pause is running ends the pause at once", async () => {
  const { waitUnlessCancelled } = await import("../native/runner.ts");
  let halted = null;
  setTimeout(() => { halted = "agent wrote outside its scope"; }, 150);
  const t0 = Date.now();
  await waitUnlessCancelled(5000, () => false, () => halted);
  assert.ok(Date.now() - t0 < 1500, `ended early, took ${Date.now() - t0} ms`);
});

// Step review: a skill stage is reviewed by default, so these tests build on a skill stage and a pass-through base.
const reviewed = (id, name, over = {}) => stage(id, name, { kind: "skill", skillId: "skills/test-driven-development", ...over });
const base = (over = {}) => ({
  async runStage() { return { ok: true, output: "" }; }, async repair() { throw new Error("no repair"); }, log() {},
  snapshotBefore: async () => ({ tree: "t0" }), ...over,
});

test("step review: an approving reviewer passes the step with no repair", async () => {
  let repairs = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), base({
    async repair() { repairs += 1; return { ok: true, output: "" }; },
    async reviewStep() { return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(out.passed, true);
  assert.deepEqual(out.stepReviews, [{ stageId: "a", stageName: "A", verdict: "approve", attempts: 0, findings: "" }]);
  assert.equal(repairs, 0);
});

test("step review: changes, then approve, repairs once with the findings and review:true", async () => {
  const repairCalls = [];
  let reviewCount = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), base({
    async reviewStep() { reviewCount += 1; return reviewCount === 1 ? { verdict: "changes", findings: "fix x" } : { verdict: "approve", findings: "" }; },
    async repair(s, o, attempt, opts) { repairCalls.push([s.id, o, attempt, opts]); return { ok: true, output: "fixed" }; },
  }));
  assert.equal(out.passed, true);
  assert.deepEqual(repairCalls, [["a", "fix x", 1, { review: true }]]);
  assert.equal(reviewCount, 2);
  assert.equal(out.stepReviews[0].verdict, "approve");
  assert.equal(out.stepReviews[0].attempts, 1);
});

test("step review: its repair budget is separate from the stage's own repair budget", async () => {
  const repairKinds = [];
  let runs = 0;
  let reviewCount = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")], { maxRepairsPerStage: 2 }), base({
    async runStage() { runs += 1; return { ok: runs > 1, output: runs > 1 ? "" : "boom" }; },
    async repair(s, o, attempt, opts) { repairKinds.push(opts?.review ? "review" : "normal"); return { ok: true, output: "fixed" }; },
    async reviewStep() { reviewCount += 1; return reviewCount < 3 ? { verdict: "changes", findings: `finding ${reviewCount}` } : { verdict: "approve", findings: "" }; },
  }));
  assert.deepEqual(repairKinds, ["normal", "review", "review"]);
  assert.equal(out.passed, true);
  assert.equal(out.stepReviews[0].verdict, "approve");
});

test("step review: a spent review budget ends the step as unresolved, but the run still passes", async () => {
  let n = 0;
  const noted = [];
  const out = await runNativeLoop(cfg([reviewed("a", "A")], { maxRepairsPerStage: 1 }), base({
    async reviewStep() { n += 1; return { verdict: "changes", findings: `finding ${n}` }; },
    async repair() { return { ok: true, output: "fixed" }; },
    async noteUnresolvedReview(s, findings) { noted.push([s.id, findings]); },
  }));
  assert.equal(out.passed, true);
  assert.equal(out.stepReviews[0].verdict, "unresolved");
  assert.equal(noted.length, 1);
  assert.match(out.statusSummary, /step reviews: 1 unresolved/);
});

test("step review: identical findings across repairs stop the review as unresolved", async () => {
  let repairs = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")], { consecutiveFailureStop: 2, maxRepairsPerStage: 5 }), base({
    async reviewStep() { return { verdict: "changes", findings: "same" }; },
    async repair() { repairs += 1; return { ok: true, output: "fixed" }; },
  }));
  assert.equal(repairs, 2, "it stops after the second repair");
  assert.equal(out.stepReviews[0].verdict, "unresolved");
  assert.equal(out.stepReviews[0].attempts, 2);
});

test("step review: the review's spend counts toward the USD ceiling and ends the run before the next stage", async () => {
  const ran = [];
  const out = await runNativeLoop(cfg([reviewed("a", "A"), reviewed("b", "B")], { maxCostUsd: 1 }), base({
    async runStage(s) { ran.push(s.id); return { ok: true, output: "" }; },
    async reviewStep() { return { verdict: "approve", findings: "", usage: { costUsd: 1.2 } }; },
  }));
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /cost ceiling reached/);
  assert.deepEqual(ran, ["a"]);
});

test("step review: a repair that crosses the USD ceiling ends the run", async () => {
  const out = await runNativeLoop(cfg([reviewed("a", "A")], { maxCostUsd: 5 }), base({
    async reviewStep() { return { verdict: "changes", findings: "fix", usage: { costUsd: 0.1 } }; },
    async repair() { return { ok: true, output: "fixed", usage: { costUsd: 6 } }; },
  }));
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /cost ceiling reached/);
  assert.equal(out.costUsd, 6.1);
});

test("step review: no baseline snapshot skips the review and records why", async () => {
  let reviewCalls = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), base({
    snapshotBefore: async () => null,
    async reviewStep() { reviewCalls += 1; return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(reviewCalls, 0);
  assert.equal(out.passed, true);
  assert.equal(out.stepReviews[0].verdict, "skipped");
  assert.equal(typeof out.stepReviews[0].reason, "string");
  assert.match(out.statusSummary, /1 skipped/);
});

test("step review: a reviewer's own skipped verdict is recorded and the run continues", async () => {
  const ran = [];
  const out = await runNativeLoop(cfg([reviewed("a", "A"), reviewed("b", "B")]), base({
    async runStage(s) { ran.push(s.id); return { ok: true, output: "" }; },
    async reviewStep() { return { verdict: "skipped", findings: "", reason: "no diff" }; },
  }));
  assert.equal(out.passed, true);
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(out.stepReviews[0].verdict, "skipped");
  assert.equal(out.stepReviews[0].reason, "no diff");
});

test("step review: default-off skill and shell stages take no snapshot and no review; reviewAfter true on a shell stage does", async () => {
  const snapshots = [];
  const reviews = [];
  const out = await runNativeLoop(cfg([
    stage("s", "Shell"),
    reviewed("w", "Plan", { skillId: "skills/writing-plans" }),
    stage("r", "Forced", { reviewAfter: true }),
  ]), base({
    async snapshotBefore(s) { snapshots.push(s.id); return { tree: "t" }; },
    async reviewStep(s) { reviews.push(s.id); return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(out.passed, true);
  assert.deepEqual(snapshots, ["r"]);
  assert.deepEqual(reviews, ["r"]);
  assert.deepEqual(out.stepReviews.map((r) => r.stageId), ["r"]);
});

test("step review: a stage that fails is not reviewed", async () => {
  let reviewCalls = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")], { maxRepairsPerStage: 1 }), base({
    async runStage() { return { ok: false, output: "boom" }; },
    async repair() { return { ok: true, output: "fixed" }; },
    async reviewStep() { reviewCalls += 1; return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(out.passed, false);
  assert.equal(reviewCalls, 0);
  assert.equal("stepReviews" in out, false);
});

test("step review: cancellation during a review ends the run as cancelled", async () => {
  let cancelled = false;
  const out = await runNativeLoop(cfg([reviewed("a", "A"), reviewed("b", "B")]), base({
    isCancelled() { return cancelled; },
    async reviewStep() { cancelled = true; return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(out.cancelled, true);
  assert.equal(out.passed, false);
});

test("step review: a deps object without reviewStep yields no stepReviews key", async () => {
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), {
    async runStage() { return { ok: true, output: "" }; }, async repair() { throw new Error("no"); }, log() {},
  });
  assert.equal(out.passed, true);
  assert.equal("stepReviews" in out, false);
});

test("step review: progress events arrive in order reviewing, fixing, reviewing, then the result", async () => {
  const events = [];
  let reviewCount = 0;
  await runNativeLoop(cfg([reviewed("a", "A")]), base({
    async reviewStep() { reviewCount += 1; return reviewCount === 1 ? { verdict: "changes", findings: "x" } : { verdict: "approve", findings: "" }; },
    async repair() { return { ok: true, output: "fixed" }; },
    onProgress(e) { if (e.type.startsWith("step-review")) events.push([e.type, e.phase ?? e.verdict]); },
  }));
  assert.deepEqual(events, [
    ["step-review", "reviewing"],
    ["step-review", "fixing"],
    ["step-review", "reviewing"],
    ["step-review-result", "approve"],
  ]);
});

test("step review: a halt raised by a passing stage ends the run before any review agent starts", async () => {
  let ran = 0;
  let halted = false;
  let reviewCalls = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), base({
    async runStage() { ran += 1; halted = true; return { ok: true, output: "edited" }; },
    halt() { return halted ? "agent edit left in place; the run stopped" : null; },
    async reviewStep() { reviewCalls += 1; return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(ran, 1);
  assert.equal(reviewCalls, 0);
  assert.equal(out.passed, false);
  assert.equal(out.blocked, true);
  assert.equal(out.statusSummary, "agent edit left in place; the run stopped");
});

test("step review: Stop during a passing stage ends the run before any review agent starts", async () => {
  let reviewCalls = 0;
  let cancelled = false;
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), base({
    async runStage() { cancelled = true; return { ok: true, output: "" }; },
    isCancelled() { return cancelled; },
    async reviewStep() { reviewCalls += 1; return { verdict: "approve", findings: "" }; },
  }));
  assert.equal(reviewCalls, 0);
  assert.equal(out.cancelled, true);
  assert.equal(out.passed, false);
});

test("step review: Stop after a changes verdict ends the run before the repair", async () => {
  let repairCalls = 0;
  let cancelled = false;
  const out = await runNativeLoop(cfg([reviewed("a", "A")]), base({
    async reviewStep() { cancelled = true; return { verdict: "changes", findings: "fix" }; },
    isCancelled() { return cancelled; },
    async repair() { repairCalls += 1; return { ok: true, output: "fixed" }; },
  }));
  assert.equal(repairCalls, 0);
  assert.equal(out.cancelled, true);
  assert.equal(out.passed, false);
});

test("step review: a repair that does not complete records the step unresolved and the run continues", async () => {
  const ran = [];
  const out = await runNativeLoop(cfg([reviewed("a", "A"), reviewed("b", "B")]), base({
    async runStage(s) { ran.push(s.id); return { ok: true, output: "" }; },
    async reviewStep(s) { return s.id === "a" ? { verdict: "changes", findings: "fix a" } : { verdict: "approve", findings: "" }; },
    async repair() { return { ok: false, output: "" }; },
  }));
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(out.passed, true);
  assert.equal(out.stepReviews[0].verdict, "unresolved");
  assert.equal(out.stepReviews[0].reason, "repair did not complete");
  assert.match(out.statusSummary, /step reviews: 1 unresolved/);
});

test("step review: the wall-clock budget ends the run between a review and its repair", async () => {
  let repairs = 0;
  const out = await runNativeLoop(cfg([reviewed("a", "A")], { wallClockBudgetSeconds: 0.05, maxIterations: 3 }), base({
    async repair() { repairs += 1; return { ok: true, output: "" }; },
    async reviewStep() { await new Promise((r) => setTimeout(r, 80)); return { verdict: "changes", findings: "fix x" }; },
  }));
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /^wall-clock budget reached/);
  assert.equal(repairs, 0);
});

// Verify loopback
const code = (id, name, over = {}) => reviewed(id, name, { runOnce: true, ...over });
const cfg3 = (stages, over = {}) => cfg(stages, { maxIterations: 3, ...over });
const verify = stage("v", "Verify");
const noRepair = async () => { throw new Error("no repair"); };

test("loopback: a failed Verify re-runs the runOnce code stage with the test output, no repair agent", async () => {
  const calls = [];
  const contexts = [];
  let vRuns = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s, _p, loopback) {
      calls.push([s.id, loopback ? loopback.round : null]);
      if (s.id === "impl") contexts.push(loopback);
      if (s.id === "v") { vRuns += 1; return { ok: vRuns > 1, output: vRuns > 1 ? "" : "boom" }; }
      return { ok: true, output: "" };
    },
    repair: noRepair,
  }));
  assert.deepEqual(calls, [["impl", null], ["v", null], ["impl", 2], ["v", null]]);
  assert.deepEqual(contexts[1], { round: 2, maxRounds: 3, findings: "Round 1 (tests)\nboom" });
  assert.equal(out.passed, true);
  assert.equal(out.iterationsUsed, 2);
});

test("loopback: never terminates - different failures each round stop at the round limit", async () => {
  const counts = { impl: 0, v: 0, repair: 0 };
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxRepairsPerStage: 1, consecutiveFailureStop: 2 }), base({
    async runStage(s) { counts[s.id] += 1; return s.id === "v" ? { ok: false, output: `fail ${"ABC"[counts.v - 1]}` } : { ok: true, output: "" }; },
    async repair() { counts.repair += 1; return { ok: true, output: "" }; },
  }));
  assert.deepEqual(counts, { impl: 3, v: 3, repair: 0 });
  assert.equal(out.passed, false);
  assert.equal(out.stoppedAtLimit, true);
  assert.equal(out.iterationsUsed, 3);
  assert.equal(out.loopback.rounds, 3);
  assert.equal(out.loopback.maxRounds, 3);
  assert.equal(out.loopback.reason, "tests");
  assert.equal(out.loopback.stopped, true);
  assert.match(out.loopback.findings, /fail C/);
  assert.equal(out.statusSummary, "Stopped after 3 rounds: tests still failing");
  assert.equal(out.failedStage.id, "v");
  assert.equal(runStatusCode(out), "stopped.limit");
});

test("loopback: a failed Verify after a code step that changed no code stops in that round as nochange", async () => {
  const counts = { impl: 0, v: 0, repair: 0 };
  const asked = [];
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { counts[s.id] += 1; asked.push(s.id); return s.id === "v" ? { ok: false, output: "Fatal Python error: Aborted" } : { ok: true, output: "" }; },
    repair: noRepair,
    codeChanged: async () => { asked.push("codeChanged"); return false; },
  }));
  assert.deepEqual(counts, { impl: 1, v: 1, repair: 0 });
  assert.deepEqual(asked, ["impl", "codeChanged", "v"], "the state is read before Verify, so files the checks leave behind never count");
  assert.equal(out.passed, false);
  assert.equal(out.stoppedAtLimit, true);
  assert.equal(out.iterationsUsed, 1);
  assert.equal(out.loopback.reason, "nochange");
  assert.equal(out.loopback.stopped, true);
  assert.match(out.loopback.findings, /Fatal Python error/);
  assert.equal(out.statusSummary, "Stopped: this run changed no code and the tests fail");
  assert.equal(runStatusCode(out), "stopped.limit");
});

test("loopback: code that did change, an unknown state, or a throwing check still loops back as before", async () => {
  const states = [async () => true, async () => null, async () => { throw new Error("git failed"); }, () => { throw new Error("sync"); }];
  for (const codeChanged of states) {
    const counts = { impl: 0, v: 0 };
    const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
      async runStage(s) { counts[s.id] += 1; return s.id === "v" ? { ok: false, output: `fail ${"ABC"[counts.v - 1]}` } : { ok: true, output: "" }; },
      repair: noRepair,
      codeChanged,
    }));
    assert.deepEqual(counts, { impl: 3, v: 3 });
    assert.equal(out.loopback.reason, "tests");
  }
});

test("loopback: a later round that leaves the code unchanged stops there", async () => {
  const counts = { impl: 0, v: 0 };
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { counts[s.id] += 1; return s.id === "v" ? { ok: false, output: `fail ${"ABC"[counts.v - 1]}` } : { ok: true, output: "" }; },
    repair: noRepair,
    codeChanged: async () => counts.impl >= 2 ? false : true,
  }));
  assert.deepEqual(counts, { impl: 2, v: 2 });
  assert.equal(out.loopback.reason, "nochange");
  assert.equal(out.loopback.rounds, 2);
});

test("loopback: a limit of one round stops after one", async () => {
  const counts = { impl: 0, v: 0 };
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 1 }), base({
    async runStage(s) { counts[s.id] += 1; return { ok: s.id !== "v", output: "x" }; }, repair: noRepair,
  }));
  assert.deepEqual(counts, { impl: 1, v: 1 });
  assert.equal(out.statusSummary, "Stopped after 1 round: tests still failing");
});

test("loopback: identical failures stop after the second round, whatever consecutiveFailureStop says", async () => {
  for (const stop of [1, 2, 5]) {
    let impl = 0;
    const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 3, consecutiveFailureStop: stop }), base({
      async runStage(s) { if (s.id === "impl") impl += 1; return { ok: s.id !== "v", output: "same" }; }, repair: noRepair,
    }));
    assert.equal(impl, 2, `stop ${stop}`);
    assert.equal(out.iterationsUsed, 2);
    assert.equal(out.stoppedAtLimit, true);
    assert.equal(out.statusSummary, "Stopped after 2 rounds: tests still failing (no change since the previous round)");
  }
});

test("loopback: any code-writing loop is capped at 3 rounds; a lower iteration setting lowers it", async () => {
  for (const [maxIterations, rounds] of [[10, 3], [2, 2]]) {
    let impl = 0, vRuns = 0;
    const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations, consecutiveFailureStop: 3 }), base({
      async runStage(s) { if (s.id === "impl") impl += 1; if (s.id === "v") { vRuns += 1; return { ok: false, output: `fail ${"ABCDEFGHIJ"[vRuns - 1]}` }; } return { ok: true, output: "" }; }, repair: noRepair,
    }));
    assert.equal(impl, rounds, `max ${maxIterations}`);
    assert.equal(out.loopback.maxRounds, rounds);
    assert.equal(out.statusSummary, `Stopped after ${rounds} rounds: tests still failing`);
  }
});

test("loopback: failures differing only in timings count as identical", async () => {
  let impl = 0, vRuns = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { if (s.id === "impl") impl += 1; if (s.id === "v") { vRuns += 1; return { ok: false, output: `1 failed in ${vRuns === 1 ? "12ms" : "15ms"}` }; } return { ok: true, output: "" }; }, repair: noRepair,
  }));
  assert.equal(impl, 2);
  assert.match(out.statusSummary, /no change since the previous round/);
});

test("loopback: identical review findings in consecutive rounds stop early", async () => {
  let impl = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 3, consecutiveFailureStop: 2 }), base({
    async runStage(s) { if (s.id === "impl") impl += 1; return { ok: true, output: "" }; }, repair: noRepair,
    async reviewStep() { return { verdict: "changes", findings: "same finding" }; },
  }));
  assert.equal(impl, 2);
  assert.equal(out.statusSummary, "Stopped after 2 rounds: review still requests changes (no change since the previous round)");
  assert.equal(out.loopback.reason, "review");
});

test("loopback: a different output resets the unchanged counter", async () => {
  let impl = 0, vRuns = 0;
  const outputs = ["a", "b", "a"];
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 3, consecutiveFailureStop: 3 }), base({
    async runStage(s) {
      if (s.id === "impl") impl += 1;
      if (s.id === "v") { vRuns += 1; return { ok: vRuns > outputs.length, output: outputs[vRuns - 1] ?? "" }; }
      return { ok: true, output: "" };
    }, repair: noRepair,
  }));
  // A repeat that is not consecutive is progress of a sort: only the round cap ends this run.
  assert.equal(impl, 3);
  assert.equal(out.statusSummary, "Stopped after 3 rounds: tests still failing");
});

test("loopback: a tests failure then a review finding with the same text is not the same signature", async () => {
  let impl = 0, vRuns = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 3, consecutiveFailureStop: 2 }), base({
    async runStage(s) {
      if (s.id === "impl") impl += 1;
      if (s.id === "v") { vRuns += 1; return { ok: vRuns > 1, output: vRuns > 1 ? "" : "same" }; }
      return { ok: true, output: "" };
    }, repair: noRepair,
    async reviewStep(_s, _snap, attempt) { return attempt === 1 ? { verdict: "changes", findings: "same" } : { verdict: "approve", findings: "" }; },
  }));
  assert.equal(impl, 3);
  assert.equal(out.passed, true);
});

test("loopback: the review runs after Verify passes, not after Implement", async () => {
  const log = [];
  const snapshots = [];
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { log.push(`run ${s.id}`); return { ok: true, output: "" }; }, repair: noRepair,
    async reviewStep(s, snapshot) { log.push(`review ${s.id}`); snapshots.push(snapshot); return { verdict: "approve", findings: "" }; },
  }));
  assert.deepEqual(log, ["run impl", "run v", "review impl"]);
  assert.deepEqual(out.stepReviews, [{ stageId: "impl", stageName: "Implement", verdict: "approve", attempts: 0, findings: "" }]);
  assert.deepEqual(snapshots, [{ tree: "t0" }]);
});

test("loopback: review changes loops back with the findings; one baseline across rounds", async () => {
  const log = [];
  const contexts = [];
  const snaps = [];
  let before = 0, reviews = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s, _p, loopback) { log.push(s.id); if (s.id === "impl") contexts.push(loopback); return { ok: true, output: "" }; }, repair: noRepair,
    async snapshotBefore() { before += 1; return { tree: "t0" }; },
    async reviewStep(_s, snapshot) { log.push("review"); snaps.push(snapshot); reviews += 1; return reviews === 1 ? { verdict: "changes", findings: "fix x" } : { verdict: "approve", findings: "" }; },
  }));
  assert.deepEqual(log, ["impl", "v", "review", "impl", "v", "review"]);
  assert.equal(contexts[1].findings, "Round 1 (review)\nfix x");
  assert.equal(out.stepReviews[0].verdict, "approve");
  assert.equal(out.stepReviews[0].attempts, 1);
  assert.equal(before, 1);
  assert.deepEqual(snaps, [{ tree: "t0" }, { tree: "t0" }]);
});

test("loopback: review changes forever stops at the limit", async () => {
  let impl = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 2, consecutiveFailureStop: 5 }), base({
    async runStage(s) { if (s.id === "impl") impl += 1; return { ok: true, output: "" }; }, repair: noRepair,
    async reviewStep() { return { verdict: "changes", findings: `f${impl}` }; },
  }));
  assert.equal(impl, 2);
  assert.equal(out.stoppedAtLimit, true);
  assert.equal(out.loopback.reason, "review");
  assert.equal(out.statusSummary, "Stopped after 2 rounds: review still requests changes");
  assert.equal(out.stepReviews[0].verdict, "unresolved");
  assert.equal(out.stepReviews[0].attempts, 2);
  assert.equal(out.stepReviews[0].reason, "round limit reached");
  assert.equal(out.failedStage.id, "v");
});

test("loopback: a review stopped by the no-change rule says so, not round limit", async () => {
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxIterations: 3, consecutiveFailureStop: 2 }), base({
    async runStage() { return { ok: true, output: "" }; }, repair: noRepair,
    async reviewStep() { return { verdict: "changes", findings: "same finding" }; },
  }));
  assert.equal(out.stoppedAtLimit, true);
  assert.equal(out.iterationsUsed, 2);
  assert.equal(out.stepReviews[0].verdict, "unresolved");
  assert.equal(out.stepReviews[0].reason, "no change since the previous round");
});

test("loopback: findings accumulate across rounds and are recorded", async () => {
  const contexts = [];
  const recorded = [];
  let vRuns = 0, reviews = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { consecutiveFailureStop: 5 }), base({
    async runStage(s, _p, loopback) {
      if (s.id === "impl") contexts.push(loopback);
      if (s.id === "v") { vRuns += 1; return { ok: vRuns > 1, output: vRuns > 1 ? "" : "A1" }; }
      return { ok: true, output: "" };
    }, repair: noRepair,
    async reviewStep() { reviews += 1; return reviews === 1 ? { verdict: "changes", findings: "B2" } : { verdict: "approve", findings: "" }; },
    async recordFindings(s, entry) { recorded.push([s.id, entry]); },
  }));
  assert.equal(out.passed, true);
  assert.equal(contexts[2].findings, "Round 1 (tests)\nA1\n\nRound 2 (review)\nB2");
  assert.deepEqual(recorded, [["impl", { round: 1, source: "tests", text: "A1" }], ["impl", { round: 2, source: "review", text: "B2" }]]);
});

test("loopback: a code stage is told only its own group's findings", async () => {
  const contexts = [];
  const v1 = stage("v1", "Verify one"), v2 = stage("v2", "Verify two");
  let v1Runs = 0, v2Runs = 0;
  await runNativeLoop(cfg3([code("tw", "Tests"), v1, code("apply", "Apply"), v2]), base({
    async runStage(s, _p, loopback) {
      if (s.id === "apply") contexts.push(loopback);
      if (s.id === "v1") { v1Runs += 1; return { ok: v1Runs > 1, output: "G1 broke" }; }
      if (s.id === "v2") { v2Runs += 1; return { ok: false, output: `G2 broke ${"AB"[v2Runs - 1] ?? "C"}` }; }
      return { ok: true, output: "" };
    }, repair: noRepair,
  }));
  assert.ok(contexts.length >= 2);
  assert.equal(contexts[0], undefined);
  assert.match(contexts[1].findings, /G2 broke A/);
  assert.doesNotMatch(contexts[1].findings, /G1 broke/);
});

test("loopback: cost ceiling after a loopback ends as a stopped run, spend kept", async () => {
  const counts = { impl: 0, v: 0 };
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxCostUsd: 1 }), base({
    async runStage(s) { counts[s.id] += 1; return s.id === "impl" ? { ok: true, output: "", usage: { costUsd: 0.6 } } : { ok: false, output: "x" }; }, repair: noRepair,
  }));
  assert.equal(out.stoppedAtLimit, true);
  assert.match(out.statusSummary, /^cost ceiling reached/);
  assert.equal(out.loopback.reason, "limit");
  assert.ok(Math.abs(out.costUsd - 1.2) < 1e-9);
  assert.equal(counts.v, 1);
  assert.equal(runStatusCode(out), "stopped.limit");
  const plain = await runNativeLoop(cfg3([stage("a", "A")], { maxCostUsd: 1 }), base({
    async runStage() { return { ok: true, output: "", usage: { costUsd: 2 } }; },
  }));
  assert.equal(plain.stoppedAtLimit, undefined);
});

test("loopback: a ceiling reached inside the review ends the run", async () => {
  const ran = [];
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { maxCostUsd: 1 }), base({
    async runStage(s) { ran.push(s.id); return { ok: true, output: "" }; }, repair: noRepair,
    async reviewStep() { return { verdict: "approve", findings: "", usage: { costUsd: 1.2 } }; },
  }));
  assert.match(out.statusSummary, /^cost ceiling reached/);
  assert.equal(out.stoppedAtLimit, true);
  assert.deepEqual(ran, ["impl", "v"]);
});

test("loopback: the wall clock ends a looping run as stopped", async () => {
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify], { wallClockBudgetSeconds: 0.001, consecutiveFailureStop: 5 }), base({
    async runStage(s) { if (s.id === "v") { await new Promise((r) => setTimeout(r, 5)); return { ok: false, output: "no" }; } return { ok: true, output: "" }; }, repair: noRepair,
  }));
  assert.equal(out.statusSummary, "wall-clock budget reached");
  assert.equal(out.stoppedAtLimit, true);
});

test("loopback: Stop between rounds cancels without a stopped flag", async () => {
  let impl = 0, cancelled = false;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { if (s.id === "impl") impl += 1; if (s.id === "v") { cancelled = true; return { ok: false, output: "x" }; } return { ok: true, output: "" }; }, repair: noRepair,
    isCancelled() { return cancelled; },
  }));
  assert.equal(out.cancelled, true);
  assert.equal(impl, 1);
  assert.equal(out.stoppedAtLimit, undefined);
});

test("loopback: progress events keep the review card in the Verify lane", async () => {
  const events = [];
  let vRuns = 0;
  await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { if (s.id === "v") { vRuns += 1; return { ok: vRuns > 1, output: "x" }; } return { ok: true, output: "" }; }, repair: noRepair,
    async reviewStep() { return { verdict: "approve", findings: "" }; },
    onProgress(e) { events.push(e); },
  }));
  const loopbackEvent = events.find((e) => e.type === "loopback");
  assert.deepEqual({ ...loopbackEvent, stage: loopbackEvent.stage.id }, { type: "loopback", stage: "v", round: 1, maxRounds: 3, reason: "tests" });
  assert.equal(events.find((e) => e.type === "step-review").stage.id, "v");
});

test("loopback: a missing baseline skips the review but tests still loop", async () => {
  let vRuns = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { if (s.id === "v") { vRuns += 1; return { ok: vRuns > 1, output: "x" }; } return { ok: true, output: "" }; }, repair: noRepair,
    snapshotBefore: async () => null,
    async reviewStep() { throw new Error("no review without a baseline"); },
  }));
  assert.equal(out.passed, true);
  assert.equal(out.stepReviews.length, 1);
  assert.equal(out.stepReviews[0].verdict, "skipped");
});

test("loopback: both code stages of a block re-run", async () => {
  const calls = [];
  let vRuns = 0;
  await runNativeLoop(cfg3([code("apply", "Apply", { skillId: "skills/refactor-apply" }), code("conform", "Conform", { skillId: "skills/refactor-conform" }), verify]), base({
    async runStage(s) { calls.push(s.id); if (s.id === "v") { vRuns += 1; return { ok: vRuns > 1, output: "x" }; } return { ok: true, output: "" }; }, repair: noRepair,
  }));
  assert.deepEqual(calls, ["apply", "conform", "v", "apply", "conform", "v"]);
});

test("loopback: a code stage with no Verify after it keeps the in-place review and repair", async () => {
  let reviews = 0;
  const repairs = [];
  const out = await runNativeLoop(cfg3([code("a", "A")]), base({
    async repair(s, _o, _n, opts) { repairs.push(opts); return { ok: true, output: "" }; },
    async reviewStep() { reviews += 1; return reviews === 1 ? { verdict: "changes", findings: "f" } : { verdict: "approve", findings: "" }; },
  }));
  assert.equal(out.passed, true);
  assert.deepEqual(repairs, [{ review: true }]);
  assert.equal(out.loopback, undefined);
});

test("the runner caps a raw config that skipped decode at 3 rounds", async () => {
  let impl = 0, vRuns = 0;
  // decodeConfig would already cap 50; spreading after it hands the runner the raw value.
  const raw = { ...cfg3([code("impl", "Implement"), verify], { consecutiveFailureStop: 3 }), maxIterations: 50 };
  const out = await runNativeLoop(raw, base({
    async runStage(s) { if (s.id === "impl") impl += 1; if (s.id === "v") { vRuns += 1; return { ok: false, output: `fail ${"ABCDEFGHIJ"[vRuns - 1]}` }; } return { ok: true, output: "" }; }, repair: noRepair,
  }));
  assert.equal(impl, 3);
  assert.equal(out.statusSummary, "Stopped after 3 rounds: tests still failing");
});

test("baseline: a Verify that already fails on the untouched tree stops the run before the code stage", async () => {
  const asked = [];
  let reviews = 0;
  const out = await runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { asked.push(s.id); return { ok: true, output: "" }; },
    repair: noRepair,
    reviewStep: async () => { reviews += 1; return { verdict: "approve", findings: "" }; },
    baselineCheck: async (stages) => { asked.push(`baseline:${stages.map((s) => s.id)}`); return { ok: false, stage: stages[0], output: "pytest aborted", costUsd: 0.5 }; },
  }));
  assert.deepEqual(asked, ["baseline:v"]);
  assert.equal(reviews, 0);
  assert.equal(out.passed, false);
  assert.equal(out.stoppedAtLimit, true);
  assert.equal(out.failedStage.id, "v");
  assert.equal(out.costUsd, 0.5);
  assert.equal(out.loopback.reason, "baseline");
  assert.equal(out.loopback.stopped, true);
  assert.match(out.loopback.findings, /pytest aborted/);
  assert.equal(out.statusSummary, "Stopped: the tests already fail before any change");
  assert.equal(runStatusCode(out), "stopped.limit");
});

test("baseline: a passing baseline runs once and leaves the loopback rounds as they were", async () => {
  const withBaseline = [];
  const without = [];
  let baselineCalls = 0;
  const run = (log, extra) => runNativeLoop(cfg3([code("impl", "Implement"), verify]), base({
    async runStage(s) { log.push(s.id); return { ok: s.id !== "v", output: `fail ${log.length}` }; },
    repair: noRepair,
    ...extra,
  }));
  const a = await run(withBaseline, { baselineCheck: async () => { baselineCalls += 1; return null; } });
  const b = await run(without, {});
  assert.equal(baselineCalls, 1);
  assert.deepEqual(withBaseline, without);
  assert.equal(a.statusSummary, b.statusSummary);
  assert.equal(a.loopback.reason, "tests");
});

// Review gate: a failed gate goes back to the code step with the review's findings instead of a repair agent.
const gate = stage("gate", "Review gate", { kind: "artifactCheck" });
const gateHook = (findings) => async (s) => (s.id === "gate" ? { codeStageId: "impl", findings: typeof findings === "function" ? findings() : findings } : null);
const gateRun = (gateOk, extra = {}, over = {}) => {
  const calls = [];
  const contexts = [];
  let gateRuns = 0;
  const promise = runNativeLoop(cfg3([code("impl", "Implement"), verify, gate], over), base({
    async runStage(s, _p, loopback) {
      calls.push(s.id);
      if (s.id === "impl") contexts.push(loopback);
      if (s.id === "gate") { gateRuns += 1; return { ok: gateOk(gateRuns), output: "verdict line missing" }; }
      return { ok: true, output: "" };
    },
    repair: noRepair, reviewStep: async () => ({ verdict: "approve", findings: "" }), ...extra,
  }));
  return { promise, calls, contexts };
};

test("review gate: a failed gate re-runs Implement with the review text, no repair, and passes on round 2", async () => {
  const { promise, calls, contexts } = gateRun((n) => n > 1, { gateLoopback: gateHook("Verdict: changes\n- add the missing test") });
  const out = await promise;
  assert.equal(out.passed, true);
  assert.deepEqual(calls, ["impl", "v", "gate", "impl", "v", "gate"]);
  assert.equal(contexts[0], undefined);
  assert.match(contexts[1].findings, /add the missing test/);
  assert.match(contexts[1].findings, /review/);
});

test("review gate: a gate that keeps failing stops at the round limit as stopped.limit, never repaired", async () => {
  let n = 0;
  const { promise, calls } = gateRun(() => false, { gateLoopback: gateHook(() => `finding ${"ABCDEFG"[n++]}`) });
  const out = await promise;
  assert.equal(calls.filter((c) => c === "impl").length, 3);
  assert.equal(out.passed, false);
  assert.equal(out.stoppedAtLimit, true);
  assert.equal(out.loopback.reason, "review");
  assert.equal(out.failedStage.id, "gate");
  assert.equal(out.statusSummary, "Stopped after 3 rounds: review still requests changes");
  assert.equal(runStatusCode(out), "stopped.limit");
  assert.equal((out.stepReviews ?? []).filter((r) => r.verdict === "unresolved").length, 0);
});

test("review gate: identical findings twice stop early", async () => {
  const { promise, calls } = gateRun(() => false, { gateLoopback: gateHook("same finding") });
  const out = await promise;
  assert.equal(calls.filter((c) => c === "impl").length, 2);
  assert.equal(out.loopback.reason, "review");
  assert.match(out.statusSummary, /no change since the previous round/);
});

test("review gate: no hook, or a hook that returns null, keeps the repair path", async () => {
  for (const extra of [{}, { gateLoopback: async () => null }]) {
    const repaired = [];
    const { promise } = gateRun((n) => n > 1, { ...extra, async repair(s) { repaired.push(s.id); return { ok: true, output: "" }; } });
    const out = await promise;
    assert.deepEqual(repaired, ["gate"]);
    assert.equal(out.loopback, undefined);
  }
});
