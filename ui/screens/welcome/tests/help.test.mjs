import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_TOPICS, HELP_GROUPS } from "../help.ts";
import { SECTIONS } from "../../shell/sections.ts";
import { ALL_GROUPS } from "../../settings/groups.ts";

test("Help covers every toolbar screen and every Settings group", () => {
  const text = HELP_TOPICS.map((t) => `${t.title} ${t.what}`).join(" ").toLowerCase();
  for (const s of SECTIONS.filter((x) => x.id !== "welcome" && x.id !== "spike")) {
    assert.ok(text.includes(s.label.toLowerCase()), `missing screen: ${s.label}`);
  }
  for (const g of ALL_GROUPS.filter((x) => x.status !== "dev-only")) {
    assert.ok(text.includes(g.title.toLowerCase()), `missing setting: ${g.title}`);
  }
});

test("Help topics are unique, grouped and every step is actionable", () => {
  assert.deepEqual(new Set(HELP_TOPICS.map((t) => t.id)).size, HELP_TOPICS.length);
  for (const t of HELP_TOPICS) {
    assert.ok(HELP_GROUPS.includes(t.group), t.id);
    assert.ok(t.what.length > 20, `${t.id} needs a beginner explanation`);
    assert.ok(t.steps.length >= 2, `${t.id} needs at least two steps`);
    assert.ok(t.example, `${t.id} needs an example`);
  }
});

test("every Screen and Settings topic can jump to its page; diagrams cover the main flows", () => {
  for (const t of HELP_TOPICS) {
    if (t.group === "Screens" || t.group === "Settings") assert.ok(t.target, `${t.id} needs a navigation target`);
  }
  for (const kind of ["map", "project", "factory", "settings", "issue", "terminal"]) {
    assert.ok(HELP_TOPICS.some((t) => t.diagram === kind), `missing ${kind} diagram`);
  }
});
