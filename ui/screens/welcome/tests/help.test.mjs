import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_TOPICS, HELP_GROUPS, HELP_FLOWS, topicFlow } from "../help.ts";
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
    if (t.group === "Settings") assert.ok(t.settingsGroup, `${t.id} needs a settings group anchor`);
  }
  for (const kind of ["map", "project", "factory", "settings", "issue", "terminal"]) {
    assert.ok(HELP_TOPICS.some((t) => t.diagram === kind), `missing ${kind} diagram`);
  }
});

test("every Start, Screen and Recipe topic has a one-line answer and a clickable flowchart that explains each step", () => {
  for (const t of HELP_TOPICS.filter((x) => x.group !== "Settings")) {
    assert.ok(t.oneLine && t.oneLine.length > 20, `${t.id} needs a one-line answer`);
    const flow = topicFlow(t);
    assert.ok(flow && flow.length >= 3, `${t.id} needs a flowchart of at least three steps`);
    for (const n of flow) assert.ok(n.label.length <= 24 && n.detail.length > 20, `${t.id}: "${n.label}" needs a short label and a real explanation`);
    assert.equal(new Set(flow.map((n) => n.label)).size, flow.length, `${t.id}: step labels repeat`);
  }
  for (const [kind, flow] of Object.entries(HELP_FLOWS)) assert.ok(flow.length >= 3, `${kind} flow is too short`);
});

test("questions have answers and every Read next link points at a real topic", () => {
  const ids = new Set(HELP_TOPICS.map((t) => t.id));
  for (const t of HELP_TOPICS) {
    for (const f of t.faq ?? []) assert.ok(f.q.trim() && f.a.length > 20, `${t.id}: empty question or answer`);
    for (const r of t.related ?? []) { assert.ok(ids.has(r), `${t.id}: unknown related topic ${r}`); assert.notEqual(r, t.id); }
  }
});

test("the Factory topic describes the process board, not the old status columns", () => {
  const f = HELP_TOPICS.find((t) => t.id === "factory");
  assert.match(f.what, /Backlog/);
  assert.doesNotMatch(f.what, /Ready to ship, Shipped/);
  assert.deepEqual(HELP_FLOWS.factory.map((n) => n.label), ["Backlog", "Plan", "Implement", "Verify", "Review", "Done"]);
});
