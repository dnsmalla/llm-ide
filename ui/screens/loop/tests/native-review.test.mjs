import { test } from "node:test";
import assert from "node:assert/strict";
import * as r from "../native/review.ts";
import * as m from "../native/model.ts";

const skill = (skillId, extra = {}) => ({ kind: "skill", skillId, reviewAfter: undefined, ...extra });

test("effectiveReviewAfter is on for skills that may write code", () => {
  for (const id of ["skills/test-driven-development", "skills/test-gap-writer", "skills/test-structure-setup", "skills/refactor-apply", "skills/refactor-conform", "skills/my-custom", "my-custom"]) {
    assert.equal(r.effectiveReviewAfter(skill(id)), true, id);
  }
});

test("effectiveReviewAfter is off for read-only or planning skills and for non-skill kinds", () => {
  for (const id of ["skills/factory-intake", "skills/writing-plans", "skills/factory-review", "skills/plan-director", "skills/plan-structure-index", "skills/doc-structure-index", "skills/refactor-planner", "skills/doc-writer", "skills/step-review"]) {
    assert.equal(r.effectiveReviewAfter(skill(id)), false, id);
  }
  for (const kind of ["shellCommand", "artifactCheck", "testMap", "codeGraph", "regressionSweep", "testPrune"]) {
    assert.equal(r.effectiveReviewAfter({ kind, skillId: null, reviewAfter: undefined }), false, kind);
  }
});

test("an explicit reviewAfter overrides the skill default in both directions", () => {
  assert.equal(r.effectiveReviewAfter(skill("skills/test-gap-writer", { reviewAfter: false })), false);
  assert.equal(r.effectiveReviewAfter(skill("skills/writing-plans", { reviewAfter: true })), true);
  assert.equal(r.effectiveReviewAfter({ kind: "shellCommand", skillId: null, reviewAfter: true }), true);
});

test("reviewModeOf defaults to auto", () => {
  assert.equal(r.reviewModeOf({}), "auto");
  assert.equal(r.reviewModeOf({ reviewMode: "auto" }), "auto");
  assert.equal(r.reviewModeOf({ reviewMode: "human" }), "human");
});

test("stepReviewPath normalizes the stage id into a file name", () => {
  assert.equal(r.stepReviewPath("custom/test-gaps-2"), ".factory/reviews/custom-test-gaps-2.md");
  assert.equal(r.STEP_REVIEW_SKILL, "skills/step-review");
  assert.equal(r.STEP_REVIEW_DIR, ".factory/reviews");
  assert.equal(r.STEP_REVIEWS_FILE, ".factory/STEP-REVIEWS.md");
  assert.equal(r.HUMAN_REVIEW_FILE, ".factory/HUMAN-REVIEW.md");
});

test("parseStepVerdict reads only an exact verdict on the last non-empty line", () => {
  assert.equal(r.parseStepVerdict("x\n\nVerdict: approve\n"), "approve");
  assert.equal(r.parseStepVerdict("Verdict: changes"), "changes");
  assert.equal(r.parseStepVerdict("**Verdict: approve**"), null);
  assert.equal(r.parseStepVerdict("Verdict: approve now"), null);
  assert.equal(r.parseStepVerdict(null), null);
  assert.equal(r.parseStepVerdict(""), null);
  assert.equal(r.parseStepVerdict("Verdict: approve\nmore text\n"), null);
});

test("the model type accepts the new optional fields", () => {
  const store = m.decodeProjectStore({ schemaVersion: 2, loops: [{ id: "l", name: "N", config: { reviewMode: "human", stages: [{ name: "s", kind: "skill", skillId: "skills/x", order: 0, reviewAfter: true }] } }] });
  assert.equal(store.loops[0].config.stages[0].reviewAfter, true);
});
