import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskId } from "../model.ts";
import { TASK_BY_ID } from "../registry.generated.ts";

test("Update Issues is an alias of Sources→Issue", () => {
  assert.equal(resolveTaskId("updateIssues"), "issues.from_notes");
  assert.equal(TASK_BY_ID["issues.update"].aliasOf, "issues.from_notes");
  assert.equal(TASK_BY_ID["issues.update"].runner, null);
});
