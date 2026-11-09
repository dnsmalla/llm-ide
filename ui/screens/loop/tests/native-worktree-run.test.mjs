import { test } from "node:test";
import assert from "node:assert/strict";
import { newRunId, repoPrefixFor, runRoot, stageHostArgs, worktreeBlockedStage } from "../native/worktree-run.ts";

const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

test("repoPrefixFor maps a worktree under system/loop-worktrees", () => {
  assert.equal(repoPrefixFor("/p", "/p/system/loop-worktrees/r1"), "system/loop-worktrees/r1");
  assert.equal(repoPrefixFor("/p", "/p/code/app"), "code/app");
  assert.equal(repoPrefixFor("/p/", "/p/code/app/"), "code/app");
  assert.equal(repoPrefixFor("/p", "/p"), "");
  assert.equal(repoPrefixFor("/p", "/p2/code/app"), "", "a sibling folder with the same prefix is not inside the project");
  assert.equal(repoPrefixFor("/p", "/elsewhere/x"), "");
  assert.equal(repoPrefixFor("", "/p/code/app"), "");
});

test("runRoot prefers the run worktree over workRoot", () => {
  assert.equal(runRoot("/p", { worktree: "/p/system/loop-worktrees/r1" }, "/p/code/app"), "/p/system/loop-worktrees/r1");
  assert.equal(runRoot("/p", null, "/p/code/app"), "/p/code/app");
  assert.equal(runRoot("/p", null, null), "/p");
});

test("newRunId matches the run id pattern and is unique for different rand values", () => {
  const now = new Date(Date.UTC(2026, 10, 9, 7, 5, 3));
  const a = newRunId(now, () => 0);
  const b = newRunId(now, () => 0.5);
  const c = newRunId(now, () => 0.9999999999);
  assert.equal(a, "20261109-070503-000000");
  for (const id of [a, b, c]) {
    assert.match(id, RUN_ID);
    assert.match(id, /^\d{8}-\d{6}-[0-9a-z]{6}$/);
  }
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.match(newRunId(now, () => Number.NaN), /^\d{8}-\d{6}-000000$/, "a broken rand still yields a valid id");
});

test("stageHostArgs adds runId only for a worktree run", () => {
  assert.deepEqual(stageHostArgs(null), {});
  assert.deepEqual(stageHostArgs("r1"), { runId: "r1" });
});

test("worktreeBlockedStage finds an enabled Regression stage only", () => {
  const stages = [
    { name: "Apply", kind: "skill", enabled: true },
    { name: "Old sweep", kind: "regressionSweep", enabled: false },
    { name: "Sweep", kind: "regressionSweep", enabled: true },
  ];
  assert.equal(worktreeBlockedStage(stages)?.name, "Sweep");
  assert.equal(worktreeBlockedStage(stages.slice(0, 2)), null);
});
