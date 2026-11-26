import { test } from "node:test";
import assert from "node:assert/strict";
import { DESKTOP_TOURS } from "../tours.ts";
import { HELP_TOPICS } from "../help.ts";
import { SECTIONS } from "../../shell/sections.ts";

test("every tour matches a real help topic and every step's screen is a real section", () => {
  const topicIds = new Set(HELP_TOPICS.map((t) => t.id));
  const sectionIds = new Set(SECTIONS.map((s) => s.id));
  assert.ok(DESKTOP_TOURS.length >= 1);
  for (const tour of DESKTOP_TOURS) {
    assert.ok(topicIds.has(tour.id), `tour ${tour.id} has no matching help topic`);
    assert.ok(tour.steps.length >= 2, `${tour.id} needs at least two steps`);
    const targetIds = new Set();
    for (const step of tour.steps) {
      assert.ok(step.targetId, `${tour.id}/${step.id} needs a targetId`);
      assert.ok(!targetIds.has(step.id), `${tour.id}: duplicate step id ${step.id}`);
      targetIds.add(step.id);
      if (step.screenId) assert.ok(sectionIds.has(step.screenId), `${tour.id}/${step.id}: unknown section ${step.screenId}`);
    }
  }
});

test("the issue tour covers Issues and Factory", () => {
  const tour = DESKTOP_TOURS.find((t) => t.id === "recipe-issue");
  assert.ok(tour, "recipe-issue tour missing");
  const screens = new Set(tour.steps.map((s) => s.screenId));
  assert.ok(screens.has("issues"));
  assert.ok(screens.has("conflicts"));
});
