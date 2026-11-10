import { test } from "node:test";
import assert from "node:assert/strict";
import { runTask } from "../runner.ts";
import { selectNextReadyIssue } from "../select-issues.ts";

const issues = [
  { id: "2", number: 2, provider: "github", repo: "o/r", title: "Later", body: "b", url: "", state: "open", isPR: false, labels: [] },
  { id: "1", number: 1, provider: "github", repo: "o/r", title: "Ready", body: "a", url: "", state: "open", isPR: false, labels: [] },
];

test("selectNextReadyIssue takes the oldest open non-PR issue with a body that has no Factory card", () => {
  assert.equal(selectNextReadyIssue(issues)?.id, "1");
  assert.equal(selectNextReadyIssue([]), null);
  assert.equal(selectNextReadyIssue([{ ...issues[1], isPR: true }]), null);
  assert.equal(selectNextReadyIssue([{ ...issues[1], body: "" }]), null);
  assert.equal(selectNextReadyIssue([{ ...issues[1], state: "closed" }]), null);
  // The card key is issue:provider:repo#number (workItemFromIssue); a taken key skips that issue.
  assert.equal(selectNextReadyIssue(issues, new Set(["issue:github:o/r#1"]))?.id, "2");
});

test("Implement Issues starts one Factory run, never an agent prompt", async () => {
  const coreCalls = [];
  let started = null;
  const out = await runTask("implementIssues", {
    projectRoot: "/p",
    core: { request: async (path) => { coreCalls.push(path); return { issues }; } },
    host: async () => null, fs: {}, log: () => {}, approvalToken: async () => null,
    changedPaths: async () => [], revert: async () => {},
    actions: {
      factoryItemKeys: async () => new Set(),
      startFactory: async (ids) => { started = ids; return { runIds: ["r1"] }; },
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.runner, "desktop-action");
  assert.deepEqual(coreCalls, ["/kb/issues?state=open"]);
  assert.deepEqual(started, ["1"]);
  assert.deepEqual(out.changedPaths, []);
});
