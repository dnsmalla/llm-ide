import { test } from "node:test";
import assert from "node:assert/strict";
import { isCheckOnlyLoop, opensMergeRequest } from "../native/check-only.ts";
import { loopRunsInWorktree } from "../native/worktree-run.ts";
import { initialProjectStore } from "../native/templates.ts";

const cfg = (openMergeRequest) => ({ openMergeRequest });

test("Regression and Plan only check; every other loop does not", () => {
  assert.equal(isCheckOnlyLoop({ defaultKey: "regression" }), true);
  assert.equal(isCheckOnlyLoop({ defaultKey: "plan" }), true);
  assert.equal(isCheckOnlyLoop({ defaultKey: "refactor" }), false);
  assert.equal(isCheckOnlyLoop({ defaultKey: "test" }), false);
  assert.equal(isCheckOnlyLoop({ defaultKey: null }), false);
});

test("a check-only loop never opens a merge request, whatever its setting", () => {
  assert.equal(opensMergeRequest({ defaultKey: "plan", config: cfg(true) }), false);
  assert.equal(opensMergeRequest({ defaultKey: "regression", config: cfg(true) }), false);
  assert.equal(opensMergeRequest({ defaultKey: "refactor", config: cfg(true) }), true);
  assert.equal(opensMergeRequest({ defaultKey: "refactor", config: cfg(false) }), false);
});

test("the built-in Regression and Plan loops are recognised by their keys", () => {
  const loops = initialProjectStore("npm test").loops;
  for (const key of ["regression", "plan"]) {
    const l = loops.find((x) => x.defaultKey === key);
    if (l) assert.equal(isCheckOnlyLoop(l), true, key);
  }
});

test("a check-only loop never runs in a worktree; another loop still does", () => {
  const loops = initialProjectStore("npm test").loops;
  const stages = [{ kind: "skill", enabled: true }];
  assert.equal(loopRunsInWorktree({ defaultKey: "plan", config: { alwaysUseWorktree: true, stages } }, false), false);
  assert.equal(loopRunsInWorktree({ defaultKey: "regression", config: { alwaysUseWorktree: true, stages } }, false), false);
  assert.equal(loopRunsInWorktree({ defaultKey: "refactor", config: { alwaysUseWorktree: true, stages } }, false), true);
  for (const l of loops) if (l.defaultKey === "plan") assert.equal(loopRunsInWorktree(l, false), false);
});
