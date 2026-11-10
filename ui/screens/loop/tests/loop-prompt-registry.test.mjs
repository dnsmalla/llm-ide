import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_LOOP_SPECS } from "../native/defaults.generated.ts";
import { TASK_BY_ID } from "../../tasks/registry.generated.ts";
import { PROMPTS } from "../../tasks/prompts.generated.ts";

// Task 14b: each starter stage prompt moved out of templates.json into schema/tasks/prompts/ and is read through the
// registry. The literal the old code shipped is kept in the fixture; the moved text must still equal it byte for byte.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/builtin-loops.v1.json", import.meta.url), "utf8"));
const templatesJson = JSON.parse(readFileSync(new URL("../../../../schema/tasks/templates.json", import.meta.url), "utf8"));
// [starter defaultKey, stage defaultKey, registry task]. A group adds its rows in the commit that moves it.
const MOVED = [
  ["test", "test-setup", "loop.test_structure_setup"],
  ["test", "test-write", "loop.test_gap_writer"],
  ["plan", "plan-structure-index", "loop.plan_structure_index"],
  ["plan", "plan-director", "loop.plan_director"],
  ["refactor", "refactor-setup", "loop.test_structure_setup"],
  ["refactor", "refactor-plan", "loop.refactor_planner"],
  ["refactor", "refactor-test-write", "loop.refactor_test_gap_writer"],
  ["refactor", "refactor-apply", "loop.refactor_apply"],
  ["refactor", "refactor-conform", "loop.refactor_conform"],
];

for (const [spec, stageKey, taskId] of MOVED) {
  test(`the ${spec}/${stageKey} prompt is read from ${taskId} and is byte-identical to the shipped literal`, () => {
    const literal = fixture.starters.find((s) => s.defaultKey === spec).config.stages.find((s) => s.defaultKey === stageKey).prompt;
    assert.equal(typeof literal, "string");
    const jsonStage = templatesJson.starters.find((s) => s.defaultKey === spec).config.stages.find((s) => s.defaultKey === stageKey);
    assert.equal(jsonStage.prompt, undefined, "the inline prompt is gone from templates.json");
    assert.equal(jsonStage.promptTask, taskId);
    assert.equal(TASK_BY_ID[taskId].runner.kind, "agent");
    assert.equal(PROMPTS[taskId], literal);
    const generated = DEFAULT_LOOP_SPECS.find((s) => s.defaultKey === spec).config.stages.find((s) => s.defaultKey === stageKey);
    assert.equal(generated.prompt, literal, "the generated stage runs the same text");
    assert.equal(generated.promptTask, undefined, "the reference is not emitted into loop data");
  });
}
