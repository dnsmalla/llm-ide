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
