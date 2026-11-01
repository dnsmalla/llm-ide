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
