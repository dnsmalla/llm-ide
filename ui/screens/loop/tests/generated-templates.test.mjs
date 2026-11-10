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
const withoutStageIds = (recipes) => recipes.map((r) => ({ ...r, config: { ...r.config, stages: r.config.stages.map(({ id, ...s }) => s) } }));
// The Factory recipe is built by factory.ts, not generated, so it is outside the generated array.
const legacyRecipes = fixture.recipes.filter((r) => r.id !== "factory");

test("generated recipes are deep-equal to the hand-written recipes they replace", () => {
  assert.deepEqual(withoutStageIds(BUILT_IN_TEMPLATES), legacyRecipes);
});

test("generated starter loops are deep-equal to the hand-written DEFAULT_LOOP_SPECS", () => {
  assert.deepEqual(DEFAULT_LOOP_SPECS, fixture.starters);
});

test("templates.ts keeps every built-in id and appends the Factory template", () => {
  const ids = templates.BUILT_IN_TEMPLATES.map((t) => t.id);
  assert.deepEqual(ids, [...legacyRecipes.map((t) => t.id), "factory"]);
  assert.equal(templates.BUILT_IN_TEMPLATES.at(-1), FACTORY_TEMPLATE);
});
