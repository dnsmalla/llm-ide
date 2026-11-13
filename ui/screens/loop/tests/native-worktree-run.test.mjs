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

test("changed-path host calls are pinned: a worktree run by its id, a main-tree run by the project it started in", async () => {
  const { changedPathArgs } = await import("../native/worktree-run.ts");
  assert.deepEqual(changedPathArgs("run-1", "/p/a"), { runId: "run-1" });
  assert.deepEqual(changedPathArgs(null, "/p/a"), { expectedRoot: "/p/a" });
  assert.deepEqual(changedPathArgs(null, null), {});
  assert.deepEqual(changedPathArgs(null, ""), {});
});

test("no screen reads or reverts changed paths without saying which run or project it means", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../../", import.meta.url).pathname;
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "tests" || name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  };
  walk(root);
  const bare = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/"loop_(?:changed|revert)_paths"[^\n]*/g)) {
      // The run manager's worktree call passes its run id literally; every other call goes through changedPathArgs.
      if (!/changedPathArgs\(|\{ runId: live\.runId \}/.test(m[0])) bare.push(`${f}: ${m[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(bare, []);
});
