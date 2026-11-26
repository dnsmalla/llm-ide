import { test } from "node:test";
import assert from "node:assert/strict";
import { routedLoopModel, stepModel, fetchRoutedLoopModel } from "../native/step-model.ts";

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

test("a failing routing fetch yields no model", async () => {
  assert.equal(await fetchRoutedLoopModel({ request: async () => { throw new Error("down"); } }), null);
  assert.equal(await fetchRoutedLoopModel({ request: async () => payload({ usable: true, tier: "cheap" }) }), "small");
});
