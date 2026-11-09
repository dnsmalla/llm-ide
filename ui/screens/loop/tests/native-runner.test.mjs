import { test } from "node:test";
import assert from "node:assert/strict";
import { runNativeLoop } from "../native/runner.ts";
import { decodeConfig } from "../native/model.ts";

function cfg(stages, over = {}) { return decodeConfig({ stages, maxIterations: 3, maxRepairsPerStage: 2, consecutiveFailureStop: 3, ...over }); }
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
