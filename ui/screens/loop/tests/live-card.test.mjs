import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCardNote, liveLoopCard, queuedLoopRuns } from "../native/live-card.ts";

test("the live card note names the model only while an agent step runs", () => {
  assert.equal(liveCardNote({ model: "Opus 5.5" }), "Running now · Opus 5.5");
  assert.equal(liveCardNote({ model: null }), "Running now");
  assert.equal(liveCardNote({}), "Running now");
});

const run = (over) => ({ runId: "r1", itemKey: "loop:L1", projectRoot: "/p", mode: "full", state: "running", startedAt: "2026-11-09T10:00:00.000Z", note: null, log: [], progress: null, ...over });

test("the live card comes from the run manager's runs: this loop, this project, started", () => {
  const progress = { stageName: "Verify", stageIndex: 1, stageCount: 4, iteration: 1, maxIterations: 3, repairs: 0, stages: [], startedAt: null, substate: null, model: "Opus 5.5" };
  const card = liveLoopCard([run({ progress })], "/p", "L1");
  assert.deepEqual(card, { runId: "r1", loopId: "L1", stageName: "Verify", startedAt: "2026-11-09T10:00:00.000Z", model: "Opus 5.5", note: null, progress: 0.5 });
  assert.equal(liveCardNote(card), "Running now · Opus 5.5");
  assert.equal(liveLoopCard([run({})], "/p", "L1").progress, null, "no progress value without a progress record");
  assert.equal(liveLoopCard([run({ progress: { ...progress, stageName: null, stageIndex: 0 } })], "/p", "L1").progress, 0, "0 before the first step starts");
  assert.equal(liveLoopCard([run({})], "/other", "L1"), null, "another project's run is not this board's");
  assert.equal(liveLoopCard([run({ itemKey: "loop:L2" })], "/p", "L1"), null, "another loop's run is not this board's");
  assert.equal(liveLoopCard([run({ itemKey: "issue:github:a/b#1" })], "/p", "L1"), null, "a Factory run is never a loop card");
  assert.equal(liveLoopCard([run({ state: "queued" })], "/p", "L1"), null, "a queued run has not started");
  assert.equal(liveCardNote(liveLoopCard([run({ state: "paused", note: "Waiting for its project" })], "/p", "L1")), "Waiting for its project");
});

test("queued runs of the loop are counted for the board's hint", () => {
  const runs = [run({ state: "queued", runId: "a" }), run({ state: "queued", runId: "b", itemKey: "loop:L2" }), run({ state: "running", runId: "c" })];
  assert.equal(queuedLoopRuns(runs, "/p", "L1"), 1);
  assert.equal(queuedLoopRuns(runs, "/q", "L1"), 0);
});

test("nothing keeps the old localStorage live-card slot", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../native/live-card.ts", import.meta.url), "utf8");
  assert.equal(/setItem|setLiveCard|llmide-loop-live/.test(src), false);
  const board = readFileSync(new URL("../../factory/LoopRuns.tsx", import.meta.url), "utf8");
  assert.match(board, /useSyncExternalStore\(subscribeRuns, liveRuns\)/);
  assert.equal(/readLiveCard|llmide-loop-live/.test(board), false);
});
