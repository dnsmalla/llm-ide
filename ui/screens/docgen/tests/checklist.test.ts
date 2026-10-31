import { test } from "node:test";
import assert from "node:assert/strict";
import { checklistSteps } from "../checklist.ts";

test("the Mac's three steps and their done states", () => {
  const none = checklistSteps("doc", false, 0);
  assert.deepEqual(none.map((s) => s.title), [
    "Choose a template or command",
    "Select code or doc files or folders",
    "Add a prompt and generate",
  ]);
  assert.deepEqual(none.map((s) => s.done), [false, false, false]);
  const ready = checklistSteps("doc", true, 2);
  assert.deepEqual(ready.map((s) => s.done), [true, true, false], "step 3 is never done in the setup view");
});

test("Visual uses the Mac's Data/Code copy and preview hint", () => {
  const steps = checklistSteps("visual", false, 1);
  assert.equal(steps[1]!.title, "Select files from Data or Code");
  assert.match(steps[1]!.detail, /tapping its NAME previews it/);
  assert.equal(steps[1]!.done, true);
});
