import { test } from "node:test";
import assert from "node:assert/strict";
import * as ui from "../native/review-ui.ts";

const stage = (skillId, extra = {}) => ({ kind: "skill", skillId, ...extra });

test("reviewSwitch reports the skill default and whether the key is explicit", () => {
  assert.deepEqual(ui.reviewSwitch(stage("skills/test-driven-development")), { eligible: true, on: true, isDefault: true });
  assert.deepEqual(ui.reviewSwitch(stage("skills/doc-writer")), { eligible: true, on: false, isDefault: true });
  assert.deepEqual(ui.reviewSwitch({ kind: "shellCommand", skillId: null }), { eligible: false, on: false, isDefault: true });
  assert.deepEqual(ui.reviewSwitch(stage("skills/doc-writer", { reviewAfter: true })), { eligible: true, on: true, isDefault: false });
});

test("setReviewAfter writes the key only when it differs from the default", () => {
  const docWriter = stage("skills/doc-writer");
  ui.setReviewAfter(docWriter, true);
  assert.equal(docWriter.reviewAfter, true);
  ui.setReviewAfter(docWriter, false);
  assert.equal("reviewAfter" in docWriter, false);
  const implement = stage("skills/test-driven-development", { reviewAfter: false });
  ui.setReviewAfter(implement, true);
  assert.equal("reviewAfter" in implement, false);
  ui.setReviewAfter(implement, false);
  assert.equal(implement.reviewAfter, false);
});

test("setReviewMode deletes the key for auto and sets human", () => {
  const config = { reviewMode: "human" };
  ui.setReviewMode(config, "auto");
  assert.equal("reviewMode" in config, false);
  ui.setReviewMode(config, "human");
  assert.equal(config.reviewMode, "human");
  assert.deepEqual(JSON.parse(JSON.stringify(config)), { reviewMode: "human" });
  assert.deepEqual(ui.REVIEW_MODE_OPTIONS.map((o) => o.value), ["auto", "human"]);
});
