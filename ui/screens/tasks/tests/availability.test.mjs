import { test } from "node:test";
import assert from "node:assert/strict";
import { taskAvailability } from "../model.ts";

const base = {
  id: "test.task",
  label: "Test",
  group: "Maintenance",
  description: "",
  aliases: [],
  runner: { kind: "agent", prompt: "prompts/test.task.md" },
  input: { kind: "project", required: false },
  output: { kind: "text", persist: "run-record", revertWrites: false },
  schedule: { backend: "desktop", defaultCron: null, schedulable: true },
  scope: "project",
  readOnly: false,
  requiresRepo: false,
  requiresLocalHost: false,
  features: [],
  availability: { status: "available", reason: null },
  revision: 1,
};

const env = { features: null, coreFeatures: null, hasRepo: true, localHost: true, mode: "local" };

test("available tasks run when their environment is satisfied", () => {
  assert.deepEqual(taskAvailability(base, env), { runnable: true, reason: null });
});

test("feature gates read both the UI and the core feature sets", () => {
  const t = { ...base, features: ["doc_gen"] };
  assert.equal(taskAvailability(t, env).runnable, true);
  assert.match(taskAvailability(t, { ...env, features: new Set(["auto_tasks"]) }).reason, /doc_gen/);
  assert.match(taskAvailability(t, { ...env, coreFeatures: new Set(["auto_tasks"]) }).reason, /doc_gen/);
});

test("remote mode refuses a task that needs the local host", () => {
  const t = { ...base, requiresLocalHost: true };
  assert.equal(taskAvailability(t, { ...env, mode: "remote" }).runnable, false);
  assert.equal(taskAvailability(t, { ...env, mode: "local" }).runnable, true);
});

test("a repo task needs a linked repository", () => {
  const t = { ...base, requiresRepo: true };
  assert.equal(taskAvailability(t, { ...env, hasRepo: false }).runnable, false);
  assert.match(taskAvailability(t, { ...env, hasRepo: false }).reason, /linked repository/i);
});

test("a desktop action needs the local host even in local mode", () => {
  const t = { ...base, runner: { kind: "desktop-action", action: "factory.start" }, requiresLocalHost: true };
  assert.equal(taskAvailability(t, { ...env, localHost: false }).runnable, false);
});

test("unported, retired and alias tasks are never runnable", () => {
  for (const status of ["unported", "retired", "alias"]) {
    const t = { ...base, runner: null, availability: { status, reason: `${status} reason` } };
    assert.deepEqual(taskAvailability(t, env), { runnable: false, reason: `${status} reason` });
  }
});
