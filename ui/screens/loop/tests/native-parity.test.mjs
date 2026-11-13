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

test("a new refactor loop runs on the desktop: isolated worktree, and a test stage after Apply", () => {
  const full = t.initialProjectStore("npm test");
  const refactor = full.loops.find((l) => l.defaultKey === "refactor");
  assert.equal(refactor.config.alwaysUseWorktree, true, "the worktree is its rollback");
  assert.equal(s.batchRollbackReason(refactor), null);
  const keys = refactor.config.stages.map((st) => st.defaultKey);
  assert.ok(keys.indexOf("refactor-test") > keys.indexOf("refactor-apply"), "Test runs after Apply");
  assert.equal(refactor.config.stages.find((st) => st.defaultKey === "refactor-test").command, "npm test");
  assert.equal(s.batchRollbackReason(full.loops.find((l) => l.defaultKey === "regression")), null);
  assert.equal(s.isBatchSkill("skills/test-gap-writer"), false, "test writing is not a batch");
});

test("batch stages are refused outside a worktree, or with no test stage after them", () => {
  const refactor = t.initialProjectStore("npm test").loops.find((l) => l.defaultKey === "refactor");
  const inPlace = { ...refactor, config: { ...refactor.config, alwaysUseWorktree: false } };
  assert.match(s.batchRollbackReason(inPlace), /isolated worktree/);
  const untested = { ...refactor, config: { ...refactor.config, stages: refactor.config.stages.map((st) => st.kind === "shellCommand" ? { ...st, enabled: false } : st) } };
  assert.match(s.batchRollbackReason(untested), /no test stage after them/);
  const full = t.initialProjectStore("npm test");
  const custom = { ...full.loops[0], defaultKey: null, config: { ...full.loops[0].config, alwaysUseWorktree: false, stages: [{ ...full.loops[0].config.stages[0], kind: "skill", skillId: "skills/refactor-apply", enabled: true }] } };
  assert.match(s.batchRollbackReason(custom), /refactor batches/);
});

test("without a test command the refactor loop only plans: no test, apply, conform or graph-check stage", () => {
  const refactor = t.initialProjectStore(null).loops.find((l) => l.defaultKey === "refactor");
  const keys = refactor.config.stages.map((st) => st.defaultKey);
  for (const k of ["refactor-test-write", "refactor-test-baseline", "refactor-apply", "refactor-conform", "refactor-test", "refactor-ledger", "refactor-graph-check"]) {
    assert.ok(!keys.includes(k), `${k} is omitted`);
  }
  assert.ok(keys.includes("refactor-plan"));
  assert.equal(s.batchRollbackReason(refactor), null);
  assert.deepEqual(refactor.config.stages.map((st) => st.order), keys.map((_, i) => i));
});

test("a refactor loop saved without tests gets its test stages back once the project has a test command", () => {
  const before = t.initialProjectStore(null);
  // The shape a project created before its repo was cloned has: test stages gone, Apply and Conform still there.
  const reference = t.initialProjectStore("pytest").loops.find((l) => l.defaultKey === "refactor");
  const broken = { ...reference, config: { ...reference.config, alwaysUseWorktree: false, stages: reference.config.stages.filter((st) => st.kind !== "shellCommand").map((st, i) => ({ ...st, order: i })) } };
  broken.config.stages[0] = { ...broken.config.stages[0], name: "My structure" };
  const store = { ...before, loops: before.loops.map((l) => l.defaultKey === "refactor" ? broken : l) };
  const r = t.ensureDefaultLoops(store, "pytest");
  const fixed = r.store.loops.find((l) => l.defaultKey === "refactor");
  assert.ok(r.upgraded.includes("Refactoring"));
  assert.equal(fixed.config.alwaysUseWorktree, true);
  const keys = fixed.config.stages.map((st) => st.defaultKey);
  assert.deepEqual(keys, reference.config.stages.map((st) => st.defaultKey), "every stage back in template order");
  assert.equal(fixed.config.stages.find((st) => st.defaultKey === "refactor-test-baseline").command, "pytest");
  assert.equal(fixed.config.stages[0].name, "My structure", "an edited stage is kept as it is");
  assert.deepEqual(fixed.config.stages.map((st) => st.order), keys.map((_, i) => i));
  assert.equal(s.batchRollbackReason(fixed), null);
  const again = t.ensureDefaultLoops(r.store, "pytest");
  assert.ok(!again.upgraded.includes("Refactoring"), "repairing twice changes nothing");
  assert.equal(t.ensureDefaultLoops(store, null).store.loops.find((l) => l.defaultKey === "refactor"), broken, "no command, no repair");
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

/** A store whose loop `defaultKey` lost the stages `keys` (as a project created before its repo was cloned has). */
const withoutStages = (store, defaultKey, keys) => ({
  ...store,
  loops: store.loops.map((l) => l.defaultKey !== defaultKey ? l : { ...l, config: { ...l.config, stages: l.config.stages.filter((st) => !keys.includes(st.defaultKey)).map((st, i) => ({ ...st, order: i })) } }),
});

test("a saved Test loop without its test stage gets it back in template order, once a command is detected", () => {
  const full = t.initialProjectStore("python3 -m pytest");
  const reference = full.loops.find((l) => l.defaultKey === "test");
  const store = withoutStages(full, "test", ["test"]);
  const r = t.ensureDefaultLoops(store, "python3 -m pytest");
  const fixed = r.store.loops.find((l) => l.defaultKey === "test");
  assert.ok(r.upgraded.includes(reference.name), "the repair is reported once");
  assert.deepEqual(fixed.config.stages.map((st) => st.defaultKey), reference.config.stages.map((st) => st.defaultKey), "template order");
  assert.equal(fixed.config.stages.find((st) => st.defaultKey === "test").command, "python3 -m pytest");
  assert.equal(fixed.config.alwaysUseWorktree, reference.config.alwaysUseWorktree, "only Refactoring gets the worktree");
  assert.deepEqual(fixed.config.stages.map((st) => st.order), fixed.config.stages.map((_, i) => i));
  const again = t.ensureDefaultLoops(r.store, "python3 -m pytest");
  assert.ok(!again.upgraded.includes(reference.name), "repairing twice changes nothing");
  assert.equal(again.store.loops.find((l) => l.defaultKey === "test"), fixed);
});

test("a saved Regression loop without its test stage gets it back, and a null command repairs nothing", () => {
  const full = t.initialProjectStore("npm test");
  const reference = full.loops.find((l) => l.defaultKey === "regression");
  const store = withoutStages(full, "regression", ["regression-test"]);
  const fixed = t.ensureDefaultLoops(store, "npm test").store.loops.find((l) => l.defaultKey === "regression");
  assert.deepEqual(fixed.config.stages.map((st) => st.defaultKey), reference.config.stages.map((st) => st.defaultKey));
  assert.equal(fixed.config.stages.find((st) => st.defaultKey === "regression-test").command, "npm test");
  assert.equal(t.ensureDefaultLoops(store, null).store.loops.find((l) => l.defaultKey === "regression"), store.loops.find((l) => l.defaultKey === "regression"), "no command, no repair");
  assert.ok(!t.ensureDefaultLoops(store, null).upgraded.includes(reference.name));
});

test("the Factory loop is never repaired", () => {
  const store = t.initialProjectStore(null);
  const before = store.loops.find((l) => l.defaultKey === "factory");
  const r = t.ensureDefaultLoops(store, "python3 -m pytest");
  assert.equal(r.store.loops.find((l) => l.defaultKey === "factory"), before);
  assert.ok(!r.upgraded.includes(before.name));
});
