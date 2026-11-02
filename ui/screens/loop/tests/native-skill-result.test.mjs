import { test } from "node:test";
import assert from "node:assert/strict";
import { agentRunSucceeded } from "../../autotasks/native/model.ts";

test("a skill stage whose skill never ran is not a pass (the shape /kb/loop/agent-run returns for a missing skill)", () => {
  assert.equal(agentRunSucceeded({ ran: false, reply: "", resultSubtype: null, unresolvedSkills: ["family/missing"] }), false);
  assert.equal(agentRunSucceeded({ ran: false, reply: "", resultSubtype: null }), false);
  assert.equal(agentRunSucceeded({ ran: true, reply: "done", resultSubtype: "success", unresolvedSkills: [] }), true);
  assert.equal(agentRunSucceeded({ ran: true, reply: "error text", resultSubtype: "error_max_turns" }), false);
});
