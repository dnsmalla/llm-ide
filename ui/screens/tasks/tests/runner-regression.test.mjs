import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";

const FAULT = "---\nstatus: fixed\nprompt: what is 2+2?\nresponse: 4\nverify: npm test\n---\n";

function fakeFs() {
  return {
    async list(path) {
      return { entries: path === "system/faults" ? [{ name: "a.md", path: "system/faults/a.md", kind: "file" }] : [] };
    },
    async read(path) {
      return path === "system/faults/a.md" ? { status: "ok", text: FAULT, hash: "h" } : { status: "missing", text: null, hash: null };
    },
  };
}

test("Regression runs the Loop regression stage and never the agent", async () => {
  const coreCalls = [];
  const hostCalls = [];
  const result = await runTask("regression", {
    projectRoot: "/p",
    core: { request: async (path) => { coreCalls.push(path); throw new Error("the agent must not run"); } },
    host: async (command) => {
      hostCalls.push(command);
      if (command === "loop_work_root") return "/p";
      if (command === "loop_run_fault_verify") return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      return null;
    },
    fs: fakeFs(),
    log: () => {},
    approvalToken: async () => "token",
    changedPaths: async () => [],
    revert: async () => {},
    actions: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.runner, "shell");
  assert.deepEqual(coreCalls, []);
  assert.ok(hostCalls.includes("loop_run_fault_verify"));
  assert.match(result.output, /verify passed/);
});
