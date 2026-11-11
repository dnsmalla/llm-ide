import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BUILT_IN_TEMPLATES } from "../native/templates.generated.ts";
import { DEFAULT_LOOP_SPECS } from "../native/defaults.generated.ts";
import * as templates from "../native/templates.ts";
import { FACTORY_TEMPLATE } from "../native/factory.ts";

// The fixture is the hand-written arrays captured before they were generated (Task 14a). Recipe stage ids are
// fresh UUIDs per load in the old code and are replaced by applyTemplate, so the fixture and the comparison drop them.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/builtin-loops.v1.json", import.meta.url), "utf8"));
// promptRef/promptHash are the Task 14d links the generator adds to prompt-bearing stages (prompt-upgrade.test.mjs
// checks them); this fixture predates them, so the comparison drops them.
const withoutLinks = ({ promptRef, promptHash, ...s }) => s;
const withoutStageIds = (recipes) => recipes.map((r) => ({ ...r, config: { ...r.config, stages: r.config.stages.map(({ id, ...s }) => withoutLinks(s)) } }));
const withoutLoopLinks = (specs) => specs.map((spec) => ({ ...spec, config: { ...spec.config, stages: spec.config.stages.map(withoutLinks) } }));
// The Factory recipe is built by factory.ts, not generated, so it is outside the generated array.
const legacyRecipes = fixture.recipes.filter((r) => r.id !== "factory");

test("generated recipes are deep-equal to the hand-written recipes they replace", () => {
  assert.deepEqual(withoutStageIds(BUILT_IN_TEMPLATES), legacyRecipes);
});

test("generated starter loops are deep-equal to the hand-written DEFAULT_LOOP_SPECS", () => {
  assert.deepEqual(withoutLoopLinks(DEFAULT_LOOP_SPECS), fixture.starters);
});

// Task 14e: the Mac app was removed on 2026-11-06, so no built-in Loop stage may still build or test it.
test("no generated Loop stage runs the removed Mac app", () => {
  const commands = [...BUILT_IN_TEMPLATES, ...DEFAULT_LOOP_SPECS].flatMap((t) => t.config.stages).map((s) => s.command ?? "");
  assert.equal(commands.some((c) => /\bmac\//.test(c) || /cd mac\b/.test(c)), false);
});

test("templates.ts keeps every built-in id and appends the Factory template", () => {
  const ids = templates.BUILT_IN_TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, [...legacyRecipes.map((t) => t.id), "factory"]);
  assert.equal(templates.BUILT_IN_TEMPLATES.at(-1), FACTORY_TEMPLATE);
});

test("the refactor test and conform stages read the plan Refactor Plan actually writes", () => {
  const refactor = BUILT_IN_TEMPLATES.find((t) => t.id === "refactoring");
  assert.ok(refactor);
  const plan = refactor.config.stages.find((s) => s.defaultKey === "refactor-plan");
  assert.ok(plan?.outputPath);
  for (const key of ["refactor-test-write", "refactor-conform"]) {
    const stage = refactor.config.stages.find((s) => s.defaultKey === key);
    assert.equal(stage?.targetPath, plan.outputPath, `${key} reads the plan, not a file nothing writes`);
  }
});
