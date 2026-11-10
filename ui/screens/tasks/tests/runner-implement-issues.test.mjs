import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";
import { selectNextReadyIssue } from "../select-issues.ts";

const issues = [
  { id: "2", number: 2, title: "Later", body: "b", state: "open", isPR: false, labels: [] },
  { id: "1", number: 1, title: "Ready", body: "a", state: "open", isPR: false, labels: [] },
];

test("selectNextReadyIssue takes the oldest open non-PR issue with a body and no card", () => {
  assert.equal(selectNextReadyIssue(issues)?.id, "1");
  assert.equal(selectNextReadyIssue(issues, new Set(["issue:1"]))?.id, "2");
  assert.equal(selectNextReadyIssue([]), null);
  assert.equal(selectNextReadyIssue([{ ...issues[0], isPR: true }]), null);
});

test("Implement Issues starts one Factory run, never an agent prompt", async () => {
  const coreCalls = [];
  let started = null;
  const out = await runTask("issues.implement", {
    projectRoot: "/p",
    core: { request: async (path) => { coreCalls.push(path); return { issues }; } },
    host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null,
    changedPaths: async () => [], revert: async () => {},
    actions: { factoryItemKeys: async () => new Set(), startFactory: async (ids) => { started = ids; return { runIds: ["r1"] }; } },
  });
  assert.equal(out.ok, true);
  assert.deepEqual(coreCalls, ["/kb/issues?state=open"]);
  assert.deepEqual(started, ["1"]);
  assert.deepEqual(out.changedPaths, []);
});
