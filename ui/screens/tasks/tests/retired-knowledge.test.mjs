import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTaskId, taskAvailability } from "../model.ts";
import { TASK_BY_ID } from "../registry.generated.ts";

test("Knowledge is retired with an honest reason and keeps its alias", () => {
  assert.equal(resolveTaskId("generateKnowledge"), "knowledge.update");
  const t = TASK_BY_ID["knowledge.update"];
  assert.equal(t.runner, null);
  assert.equal(t.availability.status, "retired");
  assert.match(t.availability.reason, /no durable memory writer/i);
  assert.equal(taskAvailability(t, { features: null, coreFeatures: null, hasRepo: true, localHost: true, mode: "local" }).runnable, false);
});
