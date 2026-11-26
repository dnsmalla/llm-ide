import { test } from "node:test";
import assert from "node:assert/strict";
import { tourReducer, currentStep, isLastStep } from "../tour-model.ts";

const flow = {
  id: "demo",
  title: "Demo tour",
  steps: [
    { id: "a", title: "A", body: "first" },
    { id: "b", title: "B", body: "second" },
    { id: "c", title: "C", body: "third" },
  ],
};

test("start sets the flow at step 0", () => {
  const s = tourReducer(null, { type: "start", flow });
  assert.equal(s.flow, flow);
  assert.equal(s.index, 0);
});

test("next advances and clamps at the last step", () => {
  let s = tourReducer(null, { type: "start", flow });
  s = tourReducer(s, { type: "next" });
  assert.equal(s.index, 1);
  s = tourReducer(s, { type: "next" });
  s = tourReducer(s, { type: "next" });
  s = tourReducer(s, { type: "next" });
  assert.equal(s.index, 2, "clamped at the last step, not past it");
});

test("back retreats and clamps at the first step", () => {
  let s = tourReducer(null, { type: "start", flow });
  s = tourReducer(s, { type: "back" });
  assert.equal(s.index, 0, "clamped at the first step, not negative");
});

test("skip ends the tour from any state", () => {
  let s = tourReducer(null, { type: "start", flow });
  s = tourReducer(s, { type: "next" });
  assert.equal(tourReducer(s, { type: "skip" }), null);
  assert.equal(tourReducer(null, { type: "skip" }), null);
});

test("next/back/skip on a null state stay null", () => {
  assert.equal(tourReducer(null, { type: "next" }), null);
  assert.equal(tourReducer(null, { type: "back" }), null);
});

test("currentStep and isLastStep read the active step", () => {
  assert.equal(currentStep(null), null);
  assert.equal(isLastStep(null), false);
  let s = tourReducer(null, { type: "start", flow });
  assert.equal(currentStep(s), flow.steps[0]);
  assert.equal(isLastStep(s), false);
  s = tourReducer(s, { type: "next" });
  s = tourReducer(s, { type: "next" });
  assert.equal(currentStep(s), flow.steps[2]);
  assert.equal(isLastStep(s), true);
});
