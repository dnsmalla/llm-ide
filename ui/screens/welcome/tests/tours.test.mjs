import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DESKTOP_TOURS } from "../tours.ts";
import { HELP_TOPICS } from "../help.ts";
import { SECTIONS } from "../../shell/sections.ts";
import { LANE_BACKLOG, LANE_DONE, LANE_MERGED } from "../../factory/board-model.ts";

const SCREENS_DIR = fileURLToPath(new URL("../../", import.meta.url));

function tsxFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tests") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Reads every real `data-tour-id` out of the JSX: exact literals, and template prefixes (`lane-${...}`). */
function liveTourIds() {
  const literals = new Set();
  const prefixes = new Set();
  for (const file of tsxFiles(SCREENS_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/data-tour-id="([^"]+)"/g)) literals.add(m[1]);
    for (const m of src.matchAll(/data-tour-id=\{`([^`$]*)\$\{/g)) prefixes.add(m[1]);
  }
  return { literals, prefixes };
}

/** The values each template prefix may expand to, taken from the registries the JSX maps over. */
function templateValues() {
  const cardSrc = readFileSync(join(SCREENS_DIR, "factory/board-model.ts"), "utf8");
  const union = cardSrc.match(/export type CardAction = ([^;]+);/);
  assert.ok(union, "CardAction union not found in board-model.ts");
  const actions = [...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return { "lane-": new Set([LANE_BACKLOG, LANE_DONE, LANE_MERGED]), "card-action-": new Set(actions) };
}

test("every tour matches a real help topic and every step's screen is a real section", () => {
  const topicIds = new Set(HELP_TOPICS.map((t) => t.id));
  const sectionIds = new Set(SECTIONS.map((s) => s.id));
  assert.ok(DESKTOP_TOURS.length >= 1);
  for (const tour of DESKTOP_TOURS) {
    assert.ok(topicIds.has(tour.id), `tour ${tour.id} has no matching help topic`);
    assert.ok(tour.steps.length >= 2, `${tour.id} needs at least two steps`);
    const stepIds = new Set();
    for (const step of tour.steps) {
      assert.ok(step.targetId, `${tour.id}/${step.id} needs a targetId`);
      assert.ok(!stepIds.has(step.id), `${tour.id}: duplicate step id ${step.id}`);
      stepIds.add(step.id);
      if (step.screenId) assert.ok(sectionIds.has(step.screenId), `${tour.id}/${step.id}: unknown section ${step.screenId}`);
    }
  }
});

test("every step's targetId matches a data-tour-id that exists in the JSX", () => {
  const { literals, prefixes } = liveTourIds();
  const values = templateValues();
  for (const prefix of prefixes) assert.ok(values[prefix], `template data-tour-id prefix "${prefix}" has no registry in this test`);
  for (const tour of DESKTOP_TOURS) {
    for (const step of tour.steps) {
      const id = step.targetId;
      if (literals.has(id)) continue;
      const prefix = [...prefixes].find((p) => id.startsWith(p));
      assert.ok(prefix, `${tour.id}/${step.id}: targetId "${id}" matches no data-tour-id in the JSX`);
      assert.ok(values[prefix].has(id.slice(prefix.length)), `${tour.id}/${step.id}: "${id.slice(prefix.length)}" is not a real value for "${prefix}"`);
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
