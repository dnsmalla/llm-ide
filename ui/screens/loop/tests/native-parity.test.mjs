import { test } from "node:test";
import assert from "node:assert/strict";
import * as t from "../native/templates.ts";
import * as h from "../native/history.ts";
import * as s from "../native/store.ts";

test("a missing default loop is re-ensured in memory and existing loops are untouched", () => {
  const full = t.initialProjectStore("npm test");
  const without = { ...full, loops: full.loops.filter((l) => l.defaultKey !== "refactor") };
  const kept = without.loops.find((l) => l.defaultKey === "regression");
  const r = t.ensureDefaultLoops(without, "npm test");
  assert.deepEqual(r.added, ["Refactoring"]);
  assert.equal(r.store.loops.length, full.loops.length);
  assert.equal(r.store.loops.find((l) => l.defaultKey === "regression"), kept);
  assert.equal(r.store.loops.find((l) => l.defaultKey === "refactor").defaultKey, "refactor");
  assert.equal(without.loops.length, full.loops.length - 1, "input store is not mutated");
  const again = t.ensureDefaultLoops(r.store, "npm test");
  assert.deepEqual(again.added, []);
});

test("a complete project store gains nothing when defaults are re-ensured", () => {
  const full = t.initialProjectStore(null);
  assert.deepEqual(t.ensureDefaultLoops(full, null).added, []);
});

test("a refactor loop is refused by the desktop runner because batch rollback is not ported", () => {
  const full = t.initialProjectStore("npm test");
  const refactor = full.loops.find((l) => l.defaultKey === "refactor");
  assert.match(s.batchRollbackReason(refactor), /batch rollback is not ported to the desktop/);
  assert.equal(s.batchRollbackReason(full.loops.find((l) => l.defaultKey === "regression")), null);
  const custom = { ...full.loops[0], defaultKey: null, config: { ...full.loops[0].config, stages: [{ ...full.loops[0].config.stages[0], kind: "skill", skillId: "skills/refactor-apply", enabled: true }] } };
  assert.match(s.batchRollbackReason(custom), /refactor batches/);
  assert.equal(s.isBatchSkill("skills/test-gap-writer"), false, "test writing is not a batch");
});

test("scheduled runs are journalled as autoTask and manual runs as manual", () => {
  assert.equal(h.runTrigger(true), "autoTask");
  assert.equal(h.runTrigger(false), "manual");
});

test("iteration rows carry the stages and repair the run inspector reads", () => {
  const stage = { id: "a", name: "Test", severity: "blocking", kind: "shellCommand" };
  const rows = h.iterationRecords([
    { index: 1, stages: [{ stage, ok: false, output: "boom" }], repair: { stageId: "a", attempt: 1, ok: true } },
    { index: 2, stages: [{ stage, ok: true, output: "ok" }], repair: null },
  ]);
  assert.deepEqual(rows[0], { index: 1, stages: [{ stageName: "Test", passed: false, severity: "blocking", output: "boom" }], repair: { stageId: "a", attempt: 1, ok: true } });
  assert.equal(rows[1].repair, null);
  assert.equal(rows[1].stages[0].passed, true);
});

test("the refactor loop runs on the desktop once its batch stages are switched off, and stays manual-only", () => {
  const refactor = t.initialProjectStore("npm test").loops.find((l) => l.defaultKey === "refactor");
  const planOnly = { ...refactor, config: { ...refactor.config, stages: refactor.config.stages.map((st) => s.isBatchSkill(st.skillId) ? { ...st, enabled: false } : st) } };
  assert.equal(s.batchRollbackReason(planOnly), null);
  assert.equal(s.isManualOnly(planOnly), true);
});

test("a re-added default loop never becomes a second primary", () => {
  const full = t.initialProjectStore("npm test");
  const loops = full.loops.filter((l) => l.defaultKey !== "regression").map((l, i) => ({ ...l, isPrimary: i === 0 }));
  const r = t.ensureDefaultLoops({ ...full, loops }, "npm test");
  assert.deepEqual(r.added.length, 1);
  assert.equal(r.store.loops.filter((l) => l.isPrimary).length, 1);
  assert.equal(r.store.loops.find((l) => l.defaultKey === "regression").isPrimary, false);
});


test("new default loops inherit the host Loop defaults; existing loops are untouched", () => {
  const full = t.initialProjectStore("npm test");
  const without = { ...full, loops: full.loops.filter((l) => l.defaultKey !== "refactor") };
  const kept = without.loops.find((l) => l.defaultKey === "regression");
  const defaults = { maxIterations: 4, consecutiveFailureStop: 1, wallClockMinutes: 15, maxRepairsPerStage: 0, pauseTimeoutMinutes: 0, protectedPathPolicy: "warn", writeSummaryNote: true };
  const r = t.ensureDefaultLoops(without, "npm test", defaults);
  const added = r.store.loops.find((l) => l.defaultKey === "refactor");
  assert.equal(added.config.maxIterations, 4);
  assert.equal(added.config.wallClockBudgetSeconds, 900);
  assert.equal(added.config.pauseTimeoutSeconds, 0);
  assert.equal(added.config.protectedPathPolicy, "warn");
  assert.equal(added.config.writeSummaryNote, true);
  assert.equal(r.store.loops.find((l) => l.defaultKey === "regression"), kept);
});

test("a first-created project store applies the host defaults to every default loop", () => {
  const defaults = { maxIterations: 4, consecutiveFailureStop: 1, wallClockMinutes: 15, maxRepairsPerStage: 0, pauseTimeoutMinutes: 0, protectedPathPolicy: "warn", writeSummaryNote: true };
  const store = t.initialProjectStore("npm test", defaults);
  assert.ok(store.loops.length > 1);
  for (const loop of store.loops) {
    assert.equal(loop.config.maxIterations, 4);
    assert.equal(loop.config.wallClockBudgetSeconds, 900);
    assert.equal(loop.config.protectedPathPolicy, "warn");
  }
});
