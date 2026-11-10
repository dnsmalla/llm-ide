import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";

function ctx(request) {
  return {
    projectRoot: "/p",
    projectId: "proj-1",
    core: { request },
    host: async () => null,
    fs: {},
    log: () => {},
    approvalToken: async () => null,
    changedPaths: async () => [],
    revert: async () => {},
    actions: {},
  };
}

test("Review Code sends no prompt to the core: the registry owns it", async () => {
  const calls = [];
  const out = await runTask("reviewCode", ctx(async (path, init) => {
    calls.push({ path, init });
    return { ok: true, summary: "No findings.", output: "No findings." };
  }));
  assert.equal(out.ok, true);
  assert.equal(out.runner, "agent");
  assert.equal(calls[0].path, "/kb/tasks/review.code/run");
  assert.deepEqual(calls[0].init.body, { projectId: "proj-1", args: {} });
  assert.equal("prompt" in calls[0].init.body, false);
  assert.equal("message" in calls[0].init.body, false);
});
