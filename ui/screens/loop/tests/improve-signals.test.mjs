import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOP_IMPROVE_MIN_API, improveAvailable, loadCoreApiVersion, loopEditSignals, postSignal, runSignalPayload } from "../native/improve/signals.ts";

const stage = (over) => ({
  id: "s", taskId: null, name: "Step", kind: "skill", command: null, order: 0, skillId: "skills/x", targetPath: null, outputPath: null,
  prompt: "old prompt", isDefault: false, enabled: true, defaultKey: "k", severity: "blocking", timeoutSeconds: 600, detectedCommand: null, check: null,
  testOp: null, graphOp: null, allowsRepair: false, runOnce: false, defaultRevision: null, disabledByDetection: null, raw: null, ...over,
});
const loopOf = (stages, over = {}) => ({
  id: "L", name: "Loop", isPrimary: false, goal: "g", acceptanceCriteria: null, scopeGlobs: [], inputPath: "", defaultKey: null, runsOnSchedule: false,
  config: { stages, maxIterations: 3, maxCostUsd: 10 }, ...over,
});
const entry = { id: "e1", loopId: "L", loopName: "Loop", startedAt: "t", durationSeconds: 12.5, iterationsUsed: 2, statusCode: "success", statusSummary: "ok", trigger: "manual" };

test("runSignalPayload reads stages, step reviews and loopback from the record", () => {
  const record = {
    costUsd: 0.42,
    stages: [{ stageName: "Plan", run: { exitCode: 0 } }, { stageName: "Verify", run: { exitCode: 1 } }],
    stepReviews: [{ stageName: "Plan", verdict: "changes", attempts: 2, findings: "x".repeat(3000), reason: "r" }],
    loopback: { rounds: 3, findings: "f" },
  };
  const p = runSignalPayload(entry, record);
  assert.deepEqual({ ...p, stepReviews: undefined }, {
    statusCode: "success", passed: true, iterations: 2, durationSeconds: 12.5, costUsd: 0.42,
    stages: [{ name: "Plan", ok: true }, { name: "Verify", ok: false }], stepReviews: undefined, loopbackRounds: 3,
  });
  assert.equal(p.stepReviews[0].findings.length, 2000);
  assert.deepEqual(Object.keys(p.stepReviews[0]), ["stageName", "verdict", "attempts", "findings"]);
  const failed = runSignalPayload({ ...entry, statusCode: "failed" }, {});
  assert.deepEqual({ passed: failed.passed, costUsd: failed.costUsd, stages: failed.stages, loopbackRounds: failed.loopbackRounds }, { passed: false, costUsd: null, stages: [], loopbackRounds: 0 });
});

test("loopEditSignals reports prompt and timeout edits, nothing when equal, nothing for new stages", () => {
  const before = loopOf([stage({ id: "a", defaultKey: "ka" }), stage({ id: "b", defaultKey: "kb" })]);
  assert.deepEqual(loopEditSignals(before, structuredClone(before)), []);
  const after = loopOf([stage({ id: "a", defaultKey: "ka", prompt: "new prompt", timeoutSeconds: 900 }), stage({ id: "b", defaultKey: "kb" })]);
  const sigs = loopEditSignals(before, after);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].stageKey, "ka");
  assert.deepEqual(sigs[0].payload.changes.prompt, { before: "old prompt", after: "new prompt" });
  assert.deepEqual(sigs[0].payload.changes.timeoutSeconds, { before: 600, after: 900 });
  const loopLevel = loopEditSignals(before, loopOf(before.config.stages, { goal: "other" }));
  assert.deepEqual(loopLevel.map((s) => s.stageKey), [null]);
  assert.deepEqual(loopLevel[0].payload.changes.goal, { before: "g", after: "other" });
});

test("improveAvailable needs a finite apiVersion of at least the floor", () => {
  assert.equal(LOOP_IMPROVE_MIN_API, 150);
  for (const [v, want] of [[150, true], [151, true], [149, false], [undefined, false], ["150", false], [NaN, false], [null, false]]) assert.equal(improveAvailable(v), want, String(v));
});

test("postSignal posts once when available and never rejects on 404 or network errors", async () => {
  const calls = [];
  const core = { async request(path, opts) { calls.push([path, opts]); return path === "/health" ? { apiVersion: 150 } : {}; } };
  await postSignal(core, { projectRoot: "/p", loopId: "L", kind: "loop_edited", payload: {} });
  await postSignal(core, { projectRoot: "/p", loopId: "L", kind: "loop_edited", payload: {} });
  assert.equal(calls.filter((c) => c[0] === "/health").length, 1, "health is read once per core");
  assert.equal(calls.filter((c) => c[0] === "/kb/loop/improve/signal").length, 2);
  assert.equal(calls.at(-1)[1].method, "POST");
  const notFound = { async request(path) { if (path === "/health") return { apiVersion: 150 }; throw Object.assign(new Error("404"), { status: 404 }); } };
  await postSignal(notFound, { projectRoot: "/p", loopId: "L", kind: "run_finished", payload: {} });
  const down = { async request() { throw new Error("network"); } };
  await postSignal(down, { projectRoot: "/p", loopId: "L", kind: "run_finished", payload: {} });
  assert.equal(await loadCoreApiVersion(down), undefined);
  const old = { async request(path) { if (path !== "/health") throw new Error("must not post"); return { apiVersion: 149 }; } };
  await postSignal(old, { projectRoot: "/p", loopId: "L", kind: "run_finished", payload: {} });
});

test("loadCoreApiVersion does not cache a failed read", async () => {
  let fail = true;
  let reads = 0;
  const core = { async request() { reads += 1; if (fail) throw new Error("starting"); return { apiVersion: 150 }; } };
  assert.equal(await loadCoreApiVersion(core), undefined);
  fail = false;
  assert.equal(await loadCoreApiVersion(core), 150);
  assert.equal(await loadCoreApiVersion(core), 150);
  assert.equal(reads, 2, "a successful read is cached");
});

test("runSignalPayload is total and an awaiting_review run counts as passed", () => {
  for (const bad of [null, undefined, 5, "x", []]) assert.doesNotThrow(() => runSignalPayload(entry, bad));
  assert.doesNotThrow(() => runSignalPayload(null, null));
  assert.equal(runSignalPayload(entry, null).stages.length, 0);
  assert.equal(runSignalPayload({ ...entry, statusCode: "awaiting_review" }, {}).passed, true);
  assert.equal(runSignalPayload({ ...entry, statusCode: "error" }, {}).passed, false);
});

test("postSignal builds a thunk payload inside its fail-open try", async () => {
  const posts = [];
  const core = { async request(path, opts) { if (path === "/health") return { apiVersion: 150 }; posts.push(opts.body); return {}; } };
  await postSignal(core, { projectRoot: "/p", loopId: "L", kind: "run_finished", payload: () => { throw new Error("bad"); } });
  assert.equal(posts.length, 0);
  await postSignal(core, { projectRoot: "/p", loopId: "L", kind: "run_finished", payload: () => ({ a: 1 }) });
  assert.deepEqual(posts[0].payload, { a: 1 });
});
