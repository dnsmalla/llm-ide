import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveDir, renderSummary, summaryPath, writeRunArchive } from "../native/summary.ts";

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

test("the summary note's status is the run record's code (the Mac writes record.statusCode)", () => {
  const at = new Date("2026-11-02T01:30:00Z");
  assert.match(renderSummary(loop, { ...outcome, blocked: true }, at), /status: blocked\.repair_out_of_scope/);
  assert.match(renderSummary(loop, { ...outcome, cancelled: true }, at), /status: aborted/);
  assert.match(renderSummary(loop, { ...outcome, passed: true }, at), /status: success/);
});

test("every run gets a folder with run.md, timings, log and the plan", async () => {
  const at = new Date("2026-11-02T01:30:00Z");
  const files = new Map();
  const fs = {
    async create() {},
    async write(p, text) { files.set(p, text); },
    async read(p) { return p.endsWith("llm-doc/loop/refactor/REFACTOR.md") ? { status: "ok", text: "# Plan\n" } : { status: "missing", text: null }; },
  };
  const withTime = { ...outcome, stages: [{ ...outcome.stages[0], durationMs: 65_000, usage: { costUsd: 0.12 } }] };
  const dir = await writeRunArchive(fs, loop, withTime, ["$ Test", "failed"], at, "system/loop-worktrees/r1");
  assert.equal(dir, archiveDir(loop, at));
  assert.match(files.get(`${dir}/run.md`), /Test\*\* — 65s · \$0\.12/);
  assert.match(files.get(`${dir}/run.md`), /\$ Test\nfailed/);
  assert.equal(files.get(`${dir}/REFACTOR.md`), "# Plan\n");
});

test("an existing archive folder still receives run.md", async () => {
  const at = new Date("2026-11-02T01:30:00Z");
  const files = new Map();
  const fs = {
    async create() { throw { code: "io", message: "exists" }; },
    async write(p, text) { files.set(p, text); },
    async read() { return { status: "missing", text: null }; },
  };
  const dir = await writeRunArchive(fs, loop, outcome, ["log"], at);
  assert.equal(dir, archiveDir(loop, at));
  assert.ok(files.has(`${dir}/run.md`));
});
