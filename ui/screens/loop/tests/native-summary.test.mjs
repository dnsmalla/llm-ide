import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummary, summaryPath } from "../native/summary.ts";

const loop = { id: "l", name: "Regression", goal: "G", acceptanceCriteria: "A" };
const outcome = { passed: false, iterationsUsed: 2, statusSummary: "Test failed", stages: [{ stage: { name: "Test", severity: "blocking" }, ok: false, output: "" }], iterations: [], failedStage: null };
test("run summary is a dated markdown note", () => {
  const at = new Date("2026-11-02T01:30:00Z");
  assert.equal(summaryPath(loop, at), "llm-doc/loop/2026/11/2026-11-02T01-30-00-regression.md");
  const md = renderSummary(loop, outcome, at);
  assert.match(md, /status: failed/);
  assert.match(md, /iterations: 2/);
  assert.match(md, /✗ \*\*Test\*\*/);
});
