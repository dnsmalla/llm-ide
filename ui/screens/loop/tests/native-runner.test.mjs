import { test } from "node:test";
import assert from "node:assert/strict";
import { runNativeLoop } from "../native/runner.ts";
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
  const out = await runNativeLoop(cfg([stage("a", "A")], { wallClockBudgetSeconds: 0.001, maxIterations: 5 }), {
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

test("R1: a snapshot stage and an apply skill stage run once across two iterations, while the failed Test is repaired and re-run", async () => {
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
  assert.deepEqual(calls, ["Snapshot", "Apply", "Test", "repair Test", "Test"]);
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
