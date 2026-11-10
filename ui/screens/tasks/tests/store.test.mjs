import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTaskState, saveTaskState, takeTaskNotices, SWITCHED_OFF_ON_MIGRATION } from "../store.ts";
import { TASK_BY_ID } from "../registry.generated.ts";
import { taskFocus } from "../model.ts";

function mem() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), map: m };
}
const LEGACY = "llmide.autoTasks.v1";

test("two projects keep different task configs", () => {
  const s = mem();
  const a = loadTaskState("/p/a", s);
  a.configs["review.code"] = { ...a.configs["review.code"], enabled: true, cron: "0 * * * *" };
  saveTaskState("/p/a", a, s);
  const b = loadTaskState("/p/b", s);
  assert.equal(b.configs["review.code"].enabled, false);
  assert.equal(loadTaskState("/p/a", s).configs["review.code"].enabled, true);
});

test("legacy global config is migrated once, by alias", () => {
  const s = mem();
  s.setItem(LEGACY, JSON.stringify({ masterEnabled: true, configs: { sourceUpdate: { enabled: true, cron: "0 9 * * *", scheduleActive: true } } }));
  const st = loadTaskState("/p/a", s);
  assert.equal(st.masterEnabled, true);
  assert.equal(st.configs["sources.update"].enabled, true);
  assert.equal(st.configs["sources.update"].cron, "0 9 * * *");
});

test("a legacy implementIssues schedule migrates switched off (D17)", () => {
  const s = mem();
  s.setItem(LEGACY, JSON.stringify({ masterEnabled: true, configs: { implementIssues: { enabled: true, scheduleActive: true, cron: "0 2 * * *" } } }));
  const st = loadTaskState("/p/a", s);
  assert.equal(st.configs["issues.implement"].scheduleActive, false);
  assert.equal(st.configs["issues.implement"].cron, "", "a none-backend task keeps no schedule");
  assert.match(st.notices.join("\n"), /switched off[\s\S]*Implement Issues/);
});

test("the D17 list names only registry ids, and each one is a real task", () => {
  for (const id of SWITCHED_OFF_ON_MIGRATION) assert.ok(TASK_BY_ID[id], id);
  for (const id of ["sources.update", "plan.status", "loop.regression", "issues.implement", "review.merge", "issues.from_notes", "review.code", "review.doc", "review.conflicts"]) {
    assert.ok(SWITCHED_OFF_ON_MIGRATION.has(id), id);
  }
});

test("a migrated review prompt that differs from the old default becomes promptOverride; an unedited one is dropped", () => {
  const s = mem();
  s.setItem(LEGACY, JSON.stringify({ configs: {
    reviewCode: { prompt: "Only check the migrations folder.", template: "custom" },
    reviewDoc: { prompt: "Review the project's documentation against the code and recent changes. Report inaccurate, missing or stale sections; do not edit files.", template: "builtin" },
  } }));
  const st = loadTaskState("/p/a", s);
  assert.equal(st.configs["review.code"].promptOverride, "Only check the migrations folder.");
  assert.equal(st.configs["review.doc"].promptOverride, null);
});

test("the legacy key is read once per project and never deleted or rewritten", () => {
  const s = mem();
  const legacy = JSON.stringify({ masterEnabled: true, configs: { regression: { enabled: true } } });
  s.setItem(LEGACY, legacy);
  assert.equal(loadTaskState("/p/a", s).masterEnabled, true);
  s.setItem(LEGACY, JSON.stringify({ masterEnabled: false, configs: {} }));
  assert.equal(loadTaskState("/p/a", s).masterEnabled, true, "project a keeps its copy");
  assert.equal(loadTaskState("/p/b", s).masterEnabled, false, "project b is migrated from the newer legacy value, once");
  assert.equal(s.getItem(LEGACY), JSON.stringify({ masterEnabled: false, configs: {} }));
});

test("promptOverride is kept only for agent tasks", () => {
  const s = mem();
  const st = loadTaskState("/p/a", s);
  st.configs["issues.implement"] = { ...st.configs["issues.implement"], promptOverride: "do it" };
  st.configs["review.code"] = { ...st.configs["review.code"], promptOverride: "check it" };
  saveTaskState("/p/a", st, s);
  const back = loadTaskState("/p/a", s);
  assert.equal(back.configs["issues.implement"].promptOverride, null);
  assert.equal(back.configs["review.code"].promptOverride, "check it");
});

test("the default prompt is the registry focus, and an unedited agent prompt has no override", () => {
  assert.ok(taskFocus("review.code"));
  const s = mem();
  s.setItem(LEGACY, JSON.stringify({ configs: { reviewCode: { prompt: taskFocus("review.code") } } }));
  assert.equal(loadTaskState("/p/a", s).configs["review.code"].promptOverride, null);
});

test("an unreadable stored state falls back to defaults and is left untouched", () => {
  const s = mem();
  s.setItem("llmide.tasks.v2:/p/a", "{not json");
  const st = loadTaskState("/p/a", s);
  assert.equal(st.masterEnabled, false);
  assert.equal(st.configs["review.code"].enabled, false);
  assert.equal(s.getItem("llmide.tasks.v2:/p/a"), "{not json");
});

test("saving over an unreadable stored state keeps a copy of it", () => {
  const s = mem();
  s.setItem("llmide.tasks.v2:/p/a", "{not json");
  const st = loadTaskState("/p/a", s);
  saveTaskState("/p/a", { ...st, masterEnabled: true }, s);
  assert.equal(s.getItem("llmide.tasks.v2:/p/a.unreadable"), "{not json");
  assert.equal(loadTaskState("/p/a", s).masterEnabled, true);
});

test("one-time notices are taken once", () => {
  const s = mem();
  s.setItem(LEGACY, JSON.stringify({ masterEnabled: true, configs: { reviewCode: { enabled: true } } }));
  const notices = takeTaskNotices("/p/a", s);
  assert.match(notices[0], /copied into this project/);
  assert.deepEqual(takeTaskNotices("/p/a", s), []);
});
