import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRoadmap } from "../native/refactor-areas.ts";
import { createStageDeps } from "../native/stage-exec.ts";

const R = (id, area, status = "todo") => `### ${id} Title (status: ${status})\n- Files: x\n${area === null ? "" : `- Area: ${area}\n`}\n`;
const A = (id, path, status, done = false) => `### ${id} ${path} (status: ${status})\n- Files: 3\n${done ? "- Done: nothing left\n" : ""}\n`;
const roadmap = (...a) => `# Areas\n\n${a.join("")}`;
const ok = roadmap(A("A1", "src/a", "done", true), A("A2", "src/b", "active"), A("A3", "src/c", "todo"));

test("a valid roadmap with batches only in the active area is fine; a sub-path, backticks and a trailing slash are accepted", () => {
  assert.deepEqual(checkRoadmap(`# Plan\n${R("R1", "src/b")}${R("R2", "`src/b/`")}${R("R3", "src/b/inner")}`, ok), []);
});

test("two active areas are a problem", () => {
  assert.match(checkRoadmap(R("R1", "src/a"), roadmap(A("A1", "src/a", "active"), A("A2", "src/b", "active"))).join("\n"), /more than one area is active: A1, A2/);
});

test("a todo batch outside the active area, or without an Area line, names the batch", () => {
  const p = checkRoadmap(`${R("R4", "src/c")}${R("R5", null)}`, ok);
  assert.equal(p.length, 2);
  assert.match(p[0], /R4 is in area src\/c, but the active area is A2 src\/b/);
  assert.match(p[1], /R5 has no `- Area:` line/);
});

test("a missing or invalid area heading, a duplicate id, no active area and a done area without Done are problems", () => {
  assert.match(checkRoadmap("", roadmap("### A1 src/a\n", A("A2", "src/b", "active"))).join("\n"), /“### A1 src\/a” is not/);
  assert.match(checkRoadmap("", roadmap(A("A1", "src/a", "paused"))).join("\n"), /A1 has the invalid status “paused”/);
  assert.match(checkRoadmap("", roadmap(A("A1", "src/a", "active"), A("A1", "src/b", "todo"))).join("\n"), /A1 appears more than once/);
  assert.match(checkRoadmap("", roadmap(A("A1", "src/a", "todo"))).join("\n"), /no area is active/);
  assert.match(checkRoadmap("", roadmap(A("A1", "src/a", "done"), A("A2", "src/b", "active"))).join("\n"), /done area A1 has no `- Done:` line/);
});

test("the all-done marker: fine when every area is done and no batch is todo; a problem with a todo batch or an open area", () => {
  const done = roadmap(A("A1", "src/a", "done", true));
  assert.deepEqual(checkRoadmap("All areas are done.\n", done), []);
  assert.match(checkRoadmap(`All areas are done.\n${R("R9", "src/a")}`, done).join("\n"), /still has todo batch R9/);
  assert.match(checkRoadmap("All areas are done.\n", ok).join("\n"), /A2 is active, A3 is todo/);
});

test("no roadmap file: one area (or none named) is fine, several areas are a problem", () => {
  assert.deepEqual(checkRoadmap(`${R("R1", null)}${R("R2", null)}`, null), []);
  assert.deepEqual(checkRoadmap(`${R("R1", "src/a")}${R("R2", "src/a")}`, null), []);
  assert.deepEqual(checkRoadmap(`${R("R1", "src/a")}${R("R2", "src/b")}`, null), ["the plan names several areas but has no REFACTOR-AREAS.md"]);
});

// ---- the Plan Check stage
const stage = (over = {}) => ({
  id: "p1", name: "Refactor Plan Check", kind: "artifactCheck", command: null, order: 0, skillId: null, targetPath: null, outputPath: null, prompt: null,
  isDefault: true, enabled: true, defaultKey: "refactor-plan-check", severity: "blocking", timeoutSeconds: null, detectedCommand: null,
  check: { requiredPaths: ["llm-doc/loop/refactor/REFACTOR.md"] }, testOp: null, graphOp: null, allowsRepair: true, defaultRevision: null, disabledByDetection: null, raw: null, ...over,
});
const loop = (s) => ({ id: "L", name: "Refactor", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], defaultKey: "refactor", runsOnSchedule: false, config: { stages: [s], maxIterations: 1, consecutiveFailureStop: 2, wallClockBudgetSeconds: null, pauseTimeoutSeconds: 0, maxRepairsPerStage: 1, repairModel: null, protectedPathPolicy: "revert", writeSummaryNote: false, extraProtectedGlobs: [], useWorktreesForConcurrentRuns: false, alwaysUseWorktree: true, openMergeRequest: true, refactorBatchesPerRun: null } });
const dir = "system/loop-worktrees/r1/llm-doc/loop/refactor";
async function planCheck(files) {
  const fs = { async read(p) { if (!(p in files)) throw Object.assign(new Error("nf"), { code: "not_found" }); return { status: "ok", text: files[p], hash: "h" }; }, async list() { return { entries: [] }; } };
  const ctx = { projectRoot: "/p", runId: "r1", runRoot: "/p/system/loop-worktrees/r1", fs, host: async () => null, core: { async request() { return {}; } }, log() {}, approvalToken: async () => "t", isCancelled: () => false, markCancelled() {} };
  const s = stage();
  return createStageDeps(ctx, loop(s)).runStage(s, []);
}

test("the Plan Check stage fails with the roadmap message when the roadmap is broken, and passes when it is valid or absent", async () => {
  const bad = await planCheck({ [`${dir}/REFACTOR.md`]: R("R1", "src/c"), [`${dir}/REFACTOR-AREAS.md`]: ok });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /^The refactor plan breaks the area roadmap contract:\n.*todo batch R1 is in area src\/c/);
  assert.equal((await planCheck({ [`${dir}/REFACTOR.md`]: R("R1", "src/b"), [`${dir}/REFACTOR-AREAS.md`]: ok })).ok, true);
  assert.equal((await planCheck({ [`${dir}/REFACTOR.md`]: R("R1", null) })).ok, true);
});
