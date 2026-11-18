import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChange, invertChange, isStale, resolveStage, shareableScope, validateChange } from "../native/improve/change.ts";
import { FACTORY_TEMPLATE } from "../native/factory.ts";
import { applyTemplate, defaultFactoryTemplate } from "../native/factory-template.ts";

const FWD = { mode: "forward" };
const REV = { mode: "revert" };
const stage = (over) => ({
  id: "s", taskId: null, name: "Step", kind: "skill", command: null, order: 0, skillId: "skills/writing-plans", targetPath: null, outputPath: null,
  prompt: null, isDefault: false, enabled: true, defaultKey: "k", severity: "blocking", timeoutSeconds: 600, detectedCommand: null, check: null,
  testOp: null, graphOp: null, allowsRepair: false, runOnce: false, defaultRevision: null, disabledByDetection: null, raw: null, ...over,
});
const loopOf = (over = {}, stages) => ({
  id: "L", name: "Loop", isPrimary: false, goal: "g", acceptanceCriteria: "ac", scopeGlobs: [], inputPath: "", defaultKey: "mine", runsOnSchedule: false,
  config: {
    stages: stages ?? [
      stage({ id: "a", name: "A", order: 0, defaultKey: "ka" }),
      stage({ id: "b", name: "B", order: 1, defaultKey: "kb", severity: "advisory" }),
      stage({ id: "c", name: "C", order: 2, defaultKey: null }),
      stage({ id: "sh", name: "Shell", order: 3, kind: "shellCommand", skillId: null, command: "npm test", defaultKey: "ksh" }),
      stage({ id: "rev", name: "Review", order: 4, skillId: "skills/factory-review", defaultKey: "krev" }),
    ],
    maxIterations: 5, consecutiveFailureStop: 2, wallClockBudgetSeconds: 3600, pauseTimeoutSeconds: 60, maxRepairsPerStage: 3, repairModel: null,
    protectedPathPolicy: "revert", writeSummaryNote: true, extraProtectedGlobs: [], useWorktreesForConcurrentRuns: false, alwaysUseWorktree: false,
    openMergeRequest: false, stageDelaySeconds: 2, refactorBatchesPerRun: 3, maxCostUsd: 10,
  },
  ...over,
});
const field = (id, f, before, after) => ({ op: "setStageField", stageId: id, stageKey: null, stageName: "x", field: f, before, after });
const cfg = (f, before, after) => ({ op: "setConfig", field: f, before, after });
const move = (id, beforeIndex, afterIndex) => ({ op: "moveStage", stageId: id, stageKey: null, stageName: "x", beforeIndex, afterIndex });
const addendum = (id, before, after, key = null) => ({ op: "setPromptAddendum", stageId: id, stageKey: key, stageName: "x", before, after });
const rejects = (c, loop = loopOf()) => assert.equal(validateChange(c, loop).ok, false, JSON.stringify(c));
const accepts = (c, loop = loopOf()) => { const r = validateChange(c, loop); assert.equal(r.ok, true, JSON.stringify(r)); return r.change; };

test("A1: weakening changes are refused", () => {
  rejects(field("a", "enabled", true, false), loopOf()); // blocking
  rejects(cfg("maxCostUsd", 10, 11));
  rejects(field("a", "severity", "blocking", "advisory"));
  rejects({ op: "setAcceptanceCriteria", before: "ac", after: "none" });
  rejects({ op: "setConfig", field: "acceptanceCriteria", before: "ac", after: "x" });
  rejects(move("sh", 3, 1));
  rejects(move("a", 0, 4)); // past the factory-review gate
  rejects(field("a", "runOnce", true, false));
  rejects(field("a", "reviewAfter", true, false));
  for (const f of ["protectedPathPolicy", "extraProtectedGlobs", "consecutiveFailureStop", "allowsRepair", "command", "prompt", "goal", "scopeGlobs"]) rejects(cfg(f, 1, 2));
  rejects(null); rejects("x"); rejects({ op: "nope" });
});

test("enabled: off only for advisory, on for any", () => {
  accepts(field("b", "enabled", true, false));
  accepts(field("a", "enabled", false, true), loopOf({}, [stage({ id: "a", enabled: false })]));
  rejects(field("zzz", "enabled", true, false));
});

test("runOnce, reviewAfter and timeout bounds", () => {
  accepts(field("a", "runOnce", false, true));
  accepts(field("a", "reviewAfter", null, true));
  accepts(field("a", "timeoutSeconds", 600, 60));
  accepts(field("a", "timeoutSeconds", 600, 14400));
  rejects(field("a", "timeoutSeconds", 600, 59));
  rejects(field("a", "timeoutSeconds", 600, 14401));
  rejects(field("a", "timeoutSeconds", 600, 90.5));
  rejects(field("a", "timeoutSeconds", 600, null));
});

test("config bounds", () => {
  const ok = (f, v) => accepts(cfg(f, 3, v));
  const bad = (f, v) => rejects(cfg(f, 3, v));
  ok("maxIterations", 1); ok("maxIterations", 50); bad("maxIterations", 0); bad("maxIterations", 51); bad("maxIterations", 2.5);
  ok("maxRepairsPerStage", 1); ok("maxRepairsPerStage", 10); bad("maxRepairsPerStage", 0); bad("maxRepairsPerStage", 11);
  ok("stageDelaySeconds", 0); ok("stageDelaySeconds", 60); bad("stageDelaySeconds", -1); bad("stageDelaySeconds", 61);
  ok("refactorBatchesPerRun", 1); ok("refactorBatchesPerRun", 20); bad("refactorBatchesPerRun", 0); bad("refactorBatchesPerRun", 21);
  ok("wallClockBudgetSeconds", 300); ok("wallClockBudgetSeconds", 14400); bad("wallClockBudgetSeconds", 299); bad("wallClockBudgetSeconds", 14401);
  bad("maxIterations", null); bad("maxIterations", "5");
});

test("maxCostUsd: positive and never above before", () => {
  accepts(cfg("maxCostUsd", 10, 10)); accepts(cfg("maxCostUsd", 10, 0.5)); accepts(cfg("maxCostUsd", null, 100));
  rejects(cfg("maxCostUsd", 10, 0)); rejects(cfg("maxCostUsd", 10, -1)); rejects(cfg("maxCostUsd", 10, null)); rejects(cfg("maxCostUsd", 10, 10.01));
});

test("addendum: non-empty, capped, control characters stripped", () => {
  const c = accepts(addendum("a", null, "  keep\tit\u0000 short\nline2\u001b  "));
  assert.equal(c.after, "keep it short\nline2");
  accepts(addendum("a", null, "x".repeat(2000)));
  rejects(addendum("a", null, "x".repeat(2001)));
  rejects(addendum("a", null, "   "));
  rejects(addendum("a", null, "\u0000\u0001"));
  rejects(addendum("a", null, 5));
});

test("moveStage: skill stages only, nothing moved past a gate", () => {
  accepts(move("a", 0, 1)); accepts(move("b", 1, 0)); accepts(move("c", 2, 0));
  rejects(move("a", 0, 3)); // crosses the shell stage
  rejects(move("c", 2, 4)); // reaches the review gate
  rejects(move("rev", 4, 0));
  rejects(move("a", 0, 0)); rejects(move("a", 0, 9)); rejects(move("a", 1, 2)); // not at position
  const intake = loopOf({}, [stage({ id: "a", order: 0 }), stage({ id: "i", order: 1, skillId: "skills/factory-intake" })]);
  rejects(move("a", 0, 1), intake);
});

test("moveStage uses the order field, not array position", () => {
  const l = loopOf({}, [stage({ id: "x", order: 2 }), stage({ id: "y", order: 0 }), stage({ id: "z", order: 1 })]);
  accepts(move("y", 0, 2), l);
  const out = applyChange(l, move("y", 0, 2), FWD);
  assert.deepEqual(out.config.stages.map((s) => [s.id, s.order]), [["z", 0], ["x", 1], ["y", 2]]);
});

test("Factory loops: only addendum and two config fields", () => {
  const f = loopOf({ defaultKey: "factory" });
  accepts(addendum("a", null, "hi"), f);
  accepts(cfg("maxRepairsPerStage", 3, 4), f); accepts(cfg("stageDelaySeconds", 2, 3), f);
  for (const c of [field("b", "enabled", true, false), field("a", "timeoutSeconds", 600, 700), field("a", "runOnce", false, true), field("a", "reviewAfter", null, true),
    move("a", 0, 1), cfg("maxIterations", 5, 4), cfg("maxCostUsd", 10, 5), cfg("wallClockBudgetSeconds", 3600, 3000), cfg("refactorBatchesPerRun", 3, 2)]) {
    const r = validateChange(c, f);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "the Factory template owns this setting");
  }
});

test("applyTemplate keeps a saved addendum and maxRepairsPerStage on a Factory loop", () => {
  const base = { id: "F", name: "Factory", isPrimary: false, goal: null, acceptanceCriteria: null, scopeGlobs: [], inputPath: "", defaultKey: "factory", runsOnSchedule: false, config: { ...structuredClone(FACTORY_TEMPLATE.config) } };
  const first = applyTemplate(base, defaultFactoryTemplate(), "npm test");
  const target = first.config.stages.find((s) => s.name === "Review") ?? first.config.stages[2];
  const saved = { ...first, config: { ...first.config, maxRepairsPerStage: 7, stages: first.config.stages.map((s) => (s.id === target.id ? { ...s, promptAddendum: "lesson" } : s)) } };
  const again = applyTemplate(saved, defaultFactoryTemplate(), "npm test");
  assert.equal(again.config.maxRepairsPerStage, 7);
  assert.equal(again.config.stages.find((s) => s.id === target.id).promptAddendum, "lesson");
});

test("isStale: true once the user edits the field (Review Focus 1)", () => {
  const l = loopOf();
  for (const c of [field("a", "timeoutSeconds", 600, 300), cfg("maxIterations", 5, 3), addendum("a", null, "x"), move("a", 0, 1)]) assert.equal(isStale(c, l), false);
  const edited = loopOf(); edited.config.stages[0].timeoutSeconds = 900; edited.config.maxIterations = 8; edited.config.stages[0].promptAddendum = "mine";
  assert.equal(isStale(field("a", "timeoutSeconds", 600, 300), edited), true);
  assert.equal(isStale(cfg("maxIterations", 5, 3), edited), true);
  assert.equal(isStale(addendum("a", null, "x"), edited), true);
  assert.equal(isStale(move("b", 0, 1), l), true);
  assert.equal(isStale(addendum("gone", null, "x"), l), true);
});

test("applyChange throws on stale and on a missing stage (Review Focus 2)", () => {
  const l = loopOf();
  l.config.maxIterations = 8;
  assert.throws(() => applyChange(l, cfg("maxIterations", 5, 3), FWD), /out of date/);
  assert.throws(() => applyChange(loopOf(), field("nope", "runOnce", false, true), FWD), /no such step/);
  assert.throws(() => applyChange(loopOf(), { op: "setConfig", field: "goal", before: 1, after: 2 }, FWD));
});

test("applyChange does not mutate the input", () => {
  const l = loopOf(); const snap = structuredClone(l);
  applyChange(l, field("a", "runOnce", false, true), FWD);
  assert.deepEqual(l, snap);
});

test("apply then invert restores the loop deep-equal", () => {
  for (const c of [field("a", "runOnce", false, true), field("b", "enabled", true, false), field("a", "timeoutSeconds", 600, 120), field("a", "reviewAfter", null, true),
    cfg("maxCostUsd", 10, 5), cfg("maxIterations", 5, 2), addendum("a", null, "lesson"), move("a", 0, 2), move("c", 2, 0)]) {
    const l = loopOf();
    const ch = accepts(c, l);
    const applied = applyChange(l, ch, FWD);
    assert.notDeepEqual(applied, l);
    assert.deepEqual(applyChange(applied, invertChange(ch), REV), l, JSON.stringify(c));
  }
  const withAdd = loopOf(); withAdd.config.stages[0].promptAddendum = "old";
  const ch = accepts(addendum("a", "old", "new"), withAdd);
  assert.deepEqual(applyChange(applyChange(withAdd, ch, FWD), invertChange(ch), REV), withAdd);
});

test("a shared addendum resolves by stageKey when the stageId differs", () => {
  const l = loopOf();
  const c = accepts(addendum("other-id", null, "tip", "kb"), l);
  assert.equal(resolveStage(c, l).id, "b");
  assert.equal(applyChange(l, c, FWD).config.stages[1].promptAddendum, "tip");
  assert.equal(resolveStage(addendum("other-id", null, "t", "missing"), l), null);
  rejects(addendum("other-id", null, "tip", "missing"));
});

test("shareableScope", () => {
  const l = loopOf();
  assert.equal(shareableScope(addendum("a", null, "x"), l), "general");
  assert.equal(shareableScope(addendum("c", null, "x"), l), "projectOnly");
  assert.equal(shareableScope(cfg("maxIterations", 5, 3), l), "general");
  assert.equal(shareableScope(cfg("maxIterations", 5, 3), loopOf({ defaultKey: null })), "projectOnly");
});

test("forward apply re-checks the rules against the current loop", () => {
  const l = loopOf();
  const ch = accepts(field("b", "enabled", true, false), l);
  const blocking = structuredClone(l); blocking.config.stages[1].severity = "blocking";
  assert.throws(() => applyChange(blocking, ch, FWD), /advisory/);
  assert.equal(applyChange(l, ch, FWD).config.stages[1].enabled, false);
  assert.throws(() => applyChange(l, cfg("maxCostUsd", 10, 20), FWD), /cannot be raised/);
  const mv = accepts(move("a", 0, 1), l);
  const changed = structuredClone(l); changed.config.stages[1].kind = "shellCommand"; changed.config.stages[1].skillId = null;
  assert.throws(() => applyChange(changed, mv, FWD), /cannot be moved/);
});

test("revert applies loosening values but keeps allowlist, Factory rule and non-null", () => {
  const l = loopOf(); l.config.maxCostUsd = 5;
  assert.equal(applyChange(l, cfg("maxCostUsd", 5, 10), REV).config.maxCostUsd, 10);
  assert.throws(() => applyChange(loopOf(), field("a", "enabled", true, null), REV), /empty/);
  assert.throws(() => applyChange(loopOf(), cfg("maxIterations", 5, null), REV), /empty/);
  assert.throws(() => applyChange(loopOf(), field("a", "severity", "blocking", "advisory"), REV));
  assert.throws(() => applyChange(loopOf({ defaultKey: "factory" }), cfg("maxIterations", 5, 4), REV), /Factory/);
});

test("severity and command fields are refused; extras ignored; stageKey and before required", () => {
  for (const f of ["severity", "command"]) {
    rejects(field("a", f, "x", "y"));
    assert.throws(() => applyChange(loopOf(), field("a", f, "x", "y"), FWD));
  }
  const raw = JSON.parse('{"__proto__":{"polluted":1},"extra":1,"op":"setConfig","field":"maxIterations","before":5,"after":3}');
  const ok = accepts(raw);
  assert.deepEqual(Object.keys(ok).sort(), ["after", "before", "field", "op"]);
  assert.equal({}.polluted, undefined);
  const { stageKey, ...noKey } = field("a", "runOnce", false, true); rejects(noKey);
  const { before, ...noBefore } = field("a", "runOnce", false, true); rejects(noBefore);
  const { before: b2, ...noBefore2 } = cfg("maxIterations", 5, 3); rejects(noBefore2);
});

test("stageName comes from the resolved stage; addendum tabs and bidi characters", () => {
  assert.equal(accepts(addendum("a", null, "x")).stageName, "A");
  assert.equal(accepts({ ...addendum("a", null, "x"), stageName: "evil" }).stageName, "A");
  assert.equal(accepts(addendum("a", null, "a\u202Eb\u200Bc\ufeffd\te")).after, "abcd e");
});
