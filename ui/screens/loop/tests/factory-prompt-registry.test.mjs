import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FACTORY_REPAIR_HINT, FACTORY_TEMPLATE } from "../native/factory.ts";
import { TASK_BY_ID } from "../../tasks/registry.generated.ts";
import { PROMPTS } from "../../tasks/prompts.generated.ts";

// Task 14c: the Factory's agent-stage prompts live in schema/tasks/prompts/ and are read through the registry. The
// fixture is the Factory template as it shipped; the stages, the repair hint and every prompt must still match it.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/factory-template.v1.json", import.meta.url), "utf8"));

test("the Factory template and its repair hint are unchanged", () => {
  assert.deepEqual(FACTORY_TEMPLATE.config, fixture.config);
  assert.equal(FACTORY_TEMPLATE.name, fixture.name);
  assert.equal(FACTORY_TEMPLATE.summary, fixture.summary);
  assert.equal(FACTORY_REPAIR_HINT, fixture.repairHint);
});

for (const [taskId, stageName] of [["factory.intake", "Intake"], ["factory.plan", "Plan"], ["factory.implement", "Implement"], ["factory.review", "Review"]]) {
  test(`${taskId} is an agent task whose prompt is the shipped ${stageName} prompt`, () => {
    const literal = fixture.config.stages.find((s) => s.name === stageName).prompt;
    assert.equal(typeof literal, "string");
    assert.equal(TASK_BY_ID[taskId].runner.kind, "agent");
    assert.equal(PROMPTS[taskId], literal);
    assert.equal(FACTORY_TEMPLATE.config.stages.find((s) => s.name === stageName).prompt, literal);
  });
}
