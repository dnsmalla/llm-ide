import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";

function ctx(request) {
  return {
    projectRoot: "/p",
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

test("a core-route task makes one POST to /kb/tasks/:id/run and maps the answer", async () => {
  const calls = [];
  const out = await runTask("sourceUpdate", ctx(async (path, init) => {
    calls.push({ path, init });
    return { ok: true, runner: "core-route", summary: "Synced 2 of 2 sources.", output: "Synced 2 of 2 sources.", warnings: [] };
  }));
  assert.equal(out.ok, true);
  assert.equal(out.runner, "core-route");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/kb/tasks/sources.update/run");
  assert.deepEqual(calls[0].init.body, { args: {} });
});

test("a core-route failure keeps its code and message", async () => {
  const out = await runTask("updatePlanStatus", ctx(async () => {
    throw Object.assign(new Error("The core refused this task."), { code: "HOST_PROOF_REQUIRED" });
  }));
  assert.equal(out.ok, false);
  assert.equal(out.code, "HOST_PROOF_REQUIRED");
  assert.match(out.summary, /refused/);
});
