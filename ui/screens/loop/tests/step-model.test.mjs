import { test } from "node:test";
import assert from "node:assert/strict";
import { routedLoopModel, routedRoleModel, stepModel, fetchRoutedModels, modelLabel } from "../native/step-model.ts";

test("modelLabel: Claude ids read as family + version, anything else as it is", () => {
  assert.equal(modelLabel("claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(modelLabel("claude-opus-5-5"), "Opus 5.5");
  assert.equal(modelLabel("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
  assert.equal(modelLabel("claude-sonnet-5"), "Sonnet 5");
  assert.equal(modelLabel("glm-4.6"), "glm-4.6");
  assert.equal(stepModel("claude-haiku-5-5", "step"), "Haiku 5.5");
});

const payload = (loop) => ({ tiers: { strong: { provider: "anthropic", model: "claude-opus-5-5" }, cheap: { provider: "x", model: "small" } }, featureStatus: { loop } });

test("routedLoopModel follows the loop feature's tier only when usable", () => {
  assert.equal(routedLoopModel(payload({ usable: true, tier: "strong" })), "claude-opus-5-5");
  assert.equal(routedLoopModel(payload({ usable: false, tier: "strong" })), null);
  assert.equal(routedLoopModel(payload({ usable: true, tier: "standard" })), null);
  assert.equal(routedLoopModel(payload(undefined)), null);
  assert.equal(routedLoopModel(null), null);
});

test("stepModel: repairModel wins only for repairs", () => {
  assert.equal(stepModel("a", "step", "r"), "a");
  assert.equal(stepModel("a", "repair", "r"), "r");
  assert.equal(stepModel("a", "repair", null), "a");
  assert.equal(stepModel(null, "step"), null);
});

test("routedRoleModel reads each role's own tier", () => {
  const r = { tiers: { strong: { model: "claude-opus-5-5" }, cheap: { model: "small" } }, featureStatus: { loop: { usable: true, tier: "cheap" }, plan: { usable: true, tier: "strong" } } };
  assert.equal(routedRoleModel(r, "loop"), "small");
  assert.equal(routedRoleModel(r, "plan"), "claude-opus-5-5");
  assert.equal(routedRoleModel({ ...r, featureStatus: { loop: r.featureStatus.loop, plan: { usable: false, tier: "strong" } } }, "plan"), null);
});

test("a failing routing fetch yields no model", async () => {
  assert.deepEqual(await fetchRoutedModels({ request: async () => { throw new Error("down"); } }), { loop: null, plan: null });
  const r = { tiers: { cheap: { model: "small" }, strong: { model: "big" } }, featureStatus: { loop: { usable: true, tier: "cheap" }, plan: { usable: true, tier: "strong" } } };
  assert.deepEqual(await fetchRoutedModels({ request: async () => r }), { loop: "small", plan: "big" });
});

import { createModelTracker } from "../native/step-model.ts";

const routing = { tiers: { cheap: { model: "claude-haiku-5-5" }, strong: { model: "claude-opus-5-5" } }, featureStatus: { loop: { usable: true, tier: "cheap" }, plan: { usable: true, tier: "strong" } } };
const coreWith = (r) => ({ request: async () => r });
const settle = () => new Promise((res) => setTimeout(res, 0));
const stage = (kind, skillId) => ({ id: "s", name: "S", kind, skillId });

test("tracker: skill step, plan skill, repair and shell steps", async () => {
  const t = createModelTracker(coreWith(routing), "claude-sonnet-5");
  await settle();
  assert.equal(t.onEvent({ type: "stage-start", stage: stage("skill", "skills/x"), index: 1, count: 2, iteration: 1 }), "Haiku 5.5");
  assert.equal(t.onEvent({ type: "stage-result", stage: stage("skill", "skills/x"), ok: true, iteration: 1 }), null);
  assert.equal(t.onEvent({ type: "stage-start", stage: stage("skill", "skills/plan-director"), index: 2, count: 2, iteration: 1 }), "Opus 5.5");
  assert.equal(t.onEvent({ type: "repair", stage: stage("skill", "skills/x") }), "Sonnet 5");
  for (const kind of ["shellCommand", "testMap", "codeGraph", "regressionSweep", "testPrune", "artifactCheck"]) {
    assert.equal(t.onEvent({ type: "stage-start", stage: stage(kind), index: 1, count: 1, iteration: 1 }), null, kind);
  }
});

test("tracker: a late routing read relabels only the running agent step", async () => {
  let resolve;
  const t = createModelTracker({ request: () => new Promise((res) => { resolve = res; }) });
  let changes = 0;
  t.onChange(() => { changes += 1; });
  assert.equal(t.onEvent({ type: "stage-start", stage: stage("skill", "skills/x"), index: 1, count: 1, iteration: 1 }), null);
  resolve(routing);
  await settle();
  assert.equal(t.label(), "Haiku 5.5");
  assert.equal(changes, 1);
  t.onEvent({ type: "stage-result", stage: stage("skill", "skills/x"), ok: true, iteration: 1 });
  const t2 = createModelTracker({ request: () => new Promise((res) => { resolve = res; }) });
  let changes2 = 0;
  t2.onChange(() => { changes2 += 1; });
  t2.onEvent({ type: "stage-start", stage: stage("shellCommand"), index: 1, count: 1, iteration: 1 });
  resolve(routing);
  await settle();
  assert.equal(t2.label(), null);
  assert.equal(changes2, 0);
});
