import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FACTORY_BUILT_IN_STAGES, FACTORY_REPAIR_HINT, FACTORY_TEMPLATE } from "../native/factory.ts";
import { TASK_BY_ID } from "../../tasks/registry.generated.ts";
import { PROMPTS } from "../../tasks/prompts.generated.ts";

// Task 14c: the Factory's agent-stage prompts live in schema/tasks/prompts/ and are read through the registry. v1 is
// the template as it first shipped (its prompts are the built-in steps' prompts); v2 is the current default process
// (no Intake; Structure verify, Test gaps and Doc review added). A change to either must be deliberate.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/factory-template.v1.json", import.meta.url), "utf8"));
const current = JSON.parse(readFileSync(new URL("./fixtures/factory-template.v2.json", import.meta.url), "utf8"));

test("the Factory template and its repair hint are unchanged", () => {
  assert.deepEqual(FACTORY_TEMPLATE.config, current.config);
  assert.equal(FACTORY_TEMPLATE.name, current.name);
  assert.equal(FACTORY_TEMPLATE.summary, current.summary);
  assert.equal(FACTORY_REPAIR_HINT, current.repairHint);
});

for (const [taskId, stageName] of [["factory.intake", "Intake"], ["factory.plan", "Plan"], ["factory.implement", "Implement"], ["factory.review", "Review"]]) {
  test(`${taskId} is an agent task whose prompt is the shipped ${stageName} prompt`, () => {
    const literal = fixture.config.stages.find((s) => s.name === stageName).prompt;
    assert.equal(typeof literal, "string");
    assert.equal(TASK_BY_ID[taskId].runner.kind, "agent");
    assert.equal(PROMPTS[taskId], literal);
    assert.equal(FACTORY_BUILT_IN_STAGES.find((s) => s.name === stageName).prompt, literal);
  });
}
