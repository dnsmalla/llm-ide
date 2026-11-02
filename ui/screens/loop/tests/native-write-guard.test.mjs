import { test } from "node:test";
import assert from "node:assert/strict";
import { revertPlan, checkWrites } from "../native/protected.ts";
import { guardedAgentCall } from "../native/agent-call.ts";
import { runNativeLoop, runStatusCode } from "../native/runner.ts";
import { decodeConfig } from "../native/model.ts";
import { iterationRecordsWithScores, attemptScore, readRecentRuns } from "../native/history.ts";

function cfg(stages, over = {}) { return decodeConfig({ stages, maxIterations: 3, maxRepairsPerStage: 2, consecutiveFailureStop: 3, ...over }); }
const stage = (id, name, over = {}) => ({ id, name, kind: "shellCommand", order: 0, enabled: true, severity: "blocking", allowsRepair: true, ...over });
const POLICY = (policy) => ({ policy, extraProtectedGlobs: [], scopeGlobs: [] });

test("revert plan: a path that was dirty before the run is never reverted", () => {
  const before = new Set(["Tests/mine.test.ts", "notes/"]);
  assert.equal(revertPlan(["Tests/mine.test.ts"], before, []).revert, false);
  assert.equal(revertPlan(["notes/draft.md"], before, []).revert, false, "a file inside a dirty untracked directory");
  assert.equal(revertPlan(["src/a.ts"], null, []).revert, false, "a failed snapshot blocks every revert");
});

test("revert plan: only the agent's own created files may be deleted, and only among the reverted paths", () => {
  const plan = revertPlan(["src/a.ts", "docs/new.md"], new Set(), ["docs/new.md", "elsewhere.md"]);
  assert.deepEqual(plan, { revert: true, paths: ["src/a.ts", "docs/new.md"], created: ["docs/new.md"] });
});

test("checkWrites: a revert undoes clean violating paths and passes the agent's created files", async () => {
  const calls = [];
  const msg = await checkWrites(["Tests/a.test.ts"], POLICY("revert"), new Set(), ["Tests/a.test.ts"], async (p, c) => { calls.push([p, c]); });
  assert.deepEqual(calls, [[["Tests/a.test.ts"], ["Tests/a.test.ts"]]]);
  assert.match(msg, /reverted/);
});

test("checkWrites: a dirty violating path halts with nothing reverted", async () => {
  let reverted = false;
  const msg = await checkWrites(["Tests/mine.test.ts"], POLICY("revert"), new Set(["Tests/mine.test.ts"]), [], async () => { reverted = true; });
  assert.equal(reverted, false);
  assert.match(msg, /uncommitted changes before the run/);
});

test("checkWrites: a failed revert is reported, never silently passed", async () => {
  const msg = await checkWrites(["Tests/a.test.ts"], POLICY("revert"), new Set(), [], async () => { throw new Error("git checkout failed"); });
  assert.match(msg, /revert failed/);
});

test("checkWrites: warn continues, off checks nothing, stop leaves the edit and returns the halt message", async () => {
  const logs = [];
  assert.equal(await checkWrites(["Tests/a.test.ts"], POLICY("warn"), new Set(), [], async () => {}, (l) => logs.push(l)), null);
  assert.equal(logs.length, 1);
  assert.equal(await checkWrites(["Tests/a.test.ts"], POLICY("off"), new Set(), [], async () => {}), null);
  assert.match(await checkWrites(["Tests/a.test.ts"], POLICY("stop"), new Set(), [], async () => { throw new Error("must not revert"); }), /left in place/);
});

test("a fake agent that writes then THROWS: its writes are checked and reverted, and the error is kept", async () => {
  const reverts = [];
  const g = await guardedAgentCall({
    before: new Set(),
    call: async () => { throw new Error("agent run timed out"); },
    changedNow: async () => ["src/app.ts", "Tests/a.test.ts"],
    check: (p, b, c) => checkWrites(p, POLICY("revert"), b, c, async (paths, created) => { reverts.push([paths, created]); }),
  });
  assert.equal(g.result, null);
  assert.equal(g.error, "agent run timed out");
  assert.deepEqual(reverts, [[["Tests/a.test.ts"], []]]);
  assert.match(g.violation, /reverted/);
});

test("a THROW on a tree the user had dirtied: their file is never judged or reverted, the agent's new edit is", async () => {
  const reverts = [];
  const g = await guardedAgentCall({
    before: new Set(["Tests/mine.test.ts", "notes/"]),
    call: async () => { throw new Error("connection dropped"); },
    // git lists the user's own dirty files too; only the newly dirty one is the agent's (the Mac's after - before).
    changedNow: async () => ["Tests/mine.test.ts", "notes/", "Tests/agent.test.ts"],
    check: (p, b, c) => checkWrites(p, POLICY("revert"), b, c, async (paths, created) => { reverts.push([paths, created]); }),
  });
  assert.equal(g.error, "connection dropped");
  assert.deepEqual(g.writes, ["Tests/agent.test.ts"]);
  assert.deepEqual(reverts, [[["Tests/agent.test.ts"], []]]);
  assert.match(g.violation, /reverted: Tests\/agent\.test\.ts$/);
});

test("a THROW with only the user's own dirty files in git status is not a violation (the Mac attributes nothing)", async () => {
  const g = await guardedAgentCall({
    before: new Set(["Tests/mine.test.ts"]),
    call: async () => { throw new Error("timeout"); },
    changedNow: async () => ["Tests/mine.test.ts"],
    check: (p, b, c) => checkWrites(p, POLICY("revert"), b, c, async () => { throw new Error("must not revert"); }),
  });
  assert.deepEqual(g.writes, []);
  assert.equal(g.violation, null);
  assert.equal(g.error, "timeout", "the original error is kept");
});

test("a THROW with no pre-run snapshot judges every changed path and reverts none", async () => {
  let reverted = false;
  const g = await guardedAgentCall({
    before: null,
    call: async () => { throw new Error("timeout"); },
    changedNow: async () => ["Tests/a.test.ts"],
    check: (p, b, c) => checkWrites(p, POLICY("revert"), b, c, async () => { reverted = true; }),
  });
  assert.equal(reverted, false);
  assert.match(g.violation, /snapshot failed/);
});

test("a throw when git cannot report the changes: the run is stopped, nothing is judged as clean", async () => {
  let checked = false;
  const g = await guardedAgentCall({
    before: new Set(),
    call: async () => { throw new Error("timeout"); },
    changedNow: async () => { throw new Error("git failed"); },
    check: async () => { checked = true; return null; },
  });
  assert.equal(checked, false);
  assert.match(g.violation, /could not be read/);
});

test("a normal return is checked with the agent's own createdPaths", async () => {
  const seen = [];
  const g = await guardedAgentCall({
    before: new Set(),
    call: async () => ({ reply: "done", changedPaths: ["docs/new.md"], createdPaths: ["docs/new.md"] }),
    changedNow: async () => [],
    check: async (p, b, c) => { seen.push([p, c]); return null; },
  });
  assert.equal(g.error, null);
  assert.equal(g.result.reply, "done");
  assert.deepEqual(seen, [[["docs/new.md"], ["docs/new.md"]]]);
});

test("a halt raised by a failing blocking stage ends the run before any repair, as blocked", async () => {
  let repaired = false;
  let stageRan = false;
  const out = await runNativeLoop(cfg([stage("a", "Agent")]), {
    async runStage() { stageRan = true; return { ok: false, output: "the agent call failed (timeout)" }; },
    async repair() { repaired = true; return { ok: true, output: "" }; }, log() {},
    // The halt is raised by the stage's own agent call, so it is only visible once the stage has run.
    halt() { return stageRan ? "agent touched a protected path and they were left in place: Tests/a.test.ts; the run stopped" : null; },
  });
  assert.equal(stageRan, true);
  assert.equal(repaired, false);
  assert.equal(out.blocked, true);
  assert.equal(out.passed, false);
  assert.equal(runStatusCode(out), "blocked.repair_out_of_scope");
});

test("pause holds before a repair attempt, and Stop while held ends the run without repairing", async () => {
  const order = [];
  let cancelled = false;
  let holds = 0;
  const out = await runNativeLoop(cfg([stage("a", "Test")]), {
    async runStage() { order.push("stage"); return { ok: false, output: "1 failing" }; },
    async repair() { order.push("repair"); return { ok: true, output: "" }; }, log() {},
    isCancelled() { return cancelled; },
    async holdWhilePaused() { order.push("hold"); holds += 1; if (holds === 3) cancelled = true; return "ok"; },
  });
  // hold at the iteration start, hold before the stage, the stage, then the hold before the repair (where Stop lands).
  assert.deepEqual(order, ["hold", "hold", "stage", "hold"]);
  assert.equal(out.cancelled, true);
  assert.equal(runStatusCode(out), "aborted");
});

test("pause that is resumed lets the repair run after the hold", async () => {
  const order = [];
  const out = await runNativeLoop(cfg([stage("a", "Test")], { maxIterations: 1 }), {
    async runStage() { order.push("stage"); return { ok: false, output: "x" }; },
    async repair() { order.push("repair"); return { ok: true, output: "" }; }, log() {},
    async holdWhilePaused() { order.push("hold"); return "ok"; },
  });
  assert.deepEqual(order, ["hold", "hold", "stage", "hold", "repair"]);
  assert.equal(out.blocked, undefined);
});

test("run status codes match the Mac: blocked, error, aborted, success, failed", () => {
  assert.equal(runStatusCode({ passed: false, blocked: true }), "blocked.repair_out_of_scope");
  assert.equal(runStatusCode({ passed: false, errored: true }), "error");
  assert.equal(runStatusCode({ passed: false, cancelled: true }), "aborted");
  assert.equal(runStatusCode({ passed: true }), "success");
  assert.equal(runStatusCode({ passed: false }), "failed");
});

test("run records written before this change still load, with any status code", async () => {
  const files = {
    "system/loop-runs/index.jsonl": [
      { id: "old-cancel", startedAt: "2026-07-01T00:00:00Z", loopId: "l", loopName: "L", statusCode: "cancelled" },
      { id: "old-fail", startedAt: "2026-07-02T00:00:00Z", loopId: "l", loopName: "L", statusCode: "failed" },
      { id: "new-block", startedAt: "2026-07-03T00:00:00Z", loopId: "l", loopName: "L", statusCode: "blocked.repair_out_of_scope" },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n",
  };
  const fs = {
    async list() { return { entries: [{ name: "index.jsonl", path: "system/loop-runs/index.jsonl" }] }; },
    async read(path) { return { status: "ok", text: files[path] }; },
  };
  const runs = await readRecentRuns(fs);
  assert.deepEqual(runs.map((r) => r.statusCode), ["blocked.repair_out_of_scope", "failed", "cancelled"]);
});

test("a test runner's failing count is the attempt score; output that is not a test report has none", () => {
  assert.equal(attemptScore("Test Case '-[AppTests testA]' failed\nTest Case '-[AppTests testB]' passed"), 1);
  assert.equal(attemptScore("  ✓ adds (2 ms)\n  ✕ subtracts (3 ms)\n  ✕ divides (1 ms)"), 2);
  assert.equal(attemptScore("hello world"), null);
});

test("the inspector rows carry the score of each shell attempt and none for a skill attempt", () => {
  const shell = { id: "t", name: "Test", severity: "blocking", kind: "shellCommand" };
  const skill = { id: "s", name: "Fix", severity: "blocking", kind: "skill" };
  const rows = iterationRecordsWithScores([
    { index: 1, stages: [{ stage: shell, ok: false, output: "Test Case '-[A b]' failed" }, { stage: skill, ok: true, output: "Test Case '-[A c]' failed" }], repair: null },
  ]);
  const stages = rows[0].stages;
  assert.equal(stages[0].score, 1);
  assert.equal(stages[1].score, null);
  assert.equal(stages[0].stageName, "Test");
});

test("an agent call that failed with nothing out of scope ends the run as error, not blocked (the Mac's .error)", async () => {
  let stageRan = false;
  const out = await runNativeLoop(cfg([stage("a", "Agent")]), {
    async runStage() { stageRan = true; return { ok: false, output: "the agent call failed (timeout)" }; },
    async repair() { throw new Error("must not repair"); }, log() {},
    halt() { return stageRan ? "the agent call failed (timeout); the run stopped" : null; },
    haltIsError() { return true; },
  });
  assert.equal(out.blocked, undefined);
  assert.equal(out.errored, true);
  assert.equal(runStatusCode(out), "error");
});

test("Stop pressed during a repair ends the run as aborted, not as a failed repair", async () => {
  let cancelled = false;
  const out = await runNativeLoop(cfg([stage("a", "Test")]), {
    async runStage() { return { ok: false, output: "x" }; },
    async repair() { cancelled = true; return { ok: false, output: "" }; }, log() {},
    isCancelled() { return cancelled; },
  });
  assert.equal(out.cancelled, true);
  assert.equal(runStatusCode(out), "aborted");
});
