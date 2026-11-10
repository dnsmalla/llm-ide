import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskId } from "../model.ts";
import { TASK_BY_ID } from "../registry.generated.ts";

test("Generate Documentation is retired; Doc Gen owns the route", () => {
  assert.equal(resolveTaskId("generateDoc"), "docs.generate");
  const t = TASK_BY_ID["docs.generate"];
  assert.equal(t.runner, null);
  assert.equal(t.availability.status, "retired");
  assert.deepEqual(t.features, ["doc_gen"]);
});
