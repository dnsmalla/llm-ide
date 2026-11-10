import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";

// The Mac's structural tasks (AutoTask.isStructural) run deterministic code; the desktop must never send them to the agent.
test("Mac structural tasks are not runnable; Regression now runs via the task registry", () => {
  const mac = ["sourcesToIssue", "implementIssues", "reviewMerge", "generateKnowledge"];
  assert.deepEqual([...m.MAC_ONLY_TASK_IDS].sort(), [...mac].sort());
  for (const id of mac) assert.equal(m.desktopRunnable(id), false, id);
  for (const id of ["sourceUpdate", "updatePlanStatus", "reviewCode", "reviewDoc", "reviewConflicts", "updateIssues", "generateDoc"]) assert.equal(m.desktopRunnable(id), true, id);
  assert.match(m.MAC_ONLY_MESSAGE, /^This task runs deterministic code in the Mac app; the desktop does not run it yet\.$/);
  assert.equal(m.TASK_BY_ID["loop.regression"].prompt, "", "the old Regression prompt is gone");
  assert.equal(m.TASK_BY_ID["sources.update"].prompt, "", "the old Source Update prompt is gone");
  assert.equal(m.TASKS.some((t) => t.id === "regression"), false, "the legacy Regression row is gone");
  assert.equal(m.TASKS.some((t) => t.id === "sourceUpdate"), false, "the legacy Source Update row is gone");
  assert.equal(m.TASKS.some((t) => t.id === "updatePlanStatus"), false, "the legacy Update Plan Status row is gone");
  assert.equal(m.desktopRunnable("regression"), true, "the alias resolves to the runnable registry task");
});

test("a schedule never fires a Mac-only task, even when armed and enabled", () => {
  const armed = { enabled: true, scheduleActive: true };
  assert.equal(m.scheduledRunAllowed("sourcesToIssue", armed, true), false);
  assert.equal(m.scheduledRunAllowed("sourceUpdate", armed, true), true);
  assert.equal(m.scheduledRunAllowed("regression", armed, true), true);
  assert.equal(m.scheduledRunAllowed("reviewCode", armed, true), true);
  assert.equal(m.scheduledRunAllowed("reviewCode", { enabled: true, scheduleActive: false }, true), false);
  assert.equal(m.scheduledRunAllowed("reviewCode", { enabled: false, scheduleActive: true }, true), false);
  assert.equal(m.scheduledRunAllowed("reviewCode", armed, false), false);
  assert.equal(m.scheduledRunAllowed("reviewCode", undefined, true), false);
});

test("the agent message is the prompt followed by the resolved input and output folders", () => {
  assert.equal(m.composeTaskMessage("P", "", ""), "P");
  assert.equal(m.composeTaskMessage("P", "src", ""), "P\n\nInput: src");
  assert.equal(m.composeTaskMessage("P", "src", "llm-doc/x"), "P\n\nInput: src\n\nOutput: llm-doc/x");
});

test("Restore Default asks first, with the Mac's wording", () => {
  assert.equal(m.resetTemplateTitle("Review Code"), 'Reset "Review Code" template to default?');
  assert.equal(m.RESET_TEMPLATE_MESSAGE, "Your custom prompt will be permanently replaced.");
});

test("the effective prompt preview and the run send the same message", () => {
  const cfg = { prompt: "P", inputPath: "./src/", outputPath: "" };
  const shown = m.composeTaskMessage(cfg.prompt, m.normalizeProjectPath(cfg.inputPath), m.normalizeProjectPath(cfg.outputPath));
  assert.equal(shown, "P\n\nInput: src");
});

test("a saved skill that is no longer in the project is marked (not installed)", async () => {
  const sk = await import("../native/skills.ts");
  assert.equal(sk.skillOptionLabel("code-review", true), "code-review");
  assert.equal(sk.skillOptionLabel("code-review", false), "code-review (not installed)");
});
