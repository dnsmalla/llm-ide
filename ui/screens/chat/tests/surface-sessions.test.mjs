import { test } from "node:test";
import assert from "node:assert/strict";
import { claimSession, sessionVisible } from "../surface-sessions.ts";

test("each dock sees only its own chats; the Chat section keeps unclaimed history", () => {
  assert.equal(sessionVisible("chat", "legacy"), true, "legacy chats stay in the Chat section");
  claimSession("docgen", "d1");
  assert.equal(sessionVisible("docgen", "d1"), true);
  assert.equal(sessionVisible("explorer", "d1"), false, "another dock cannot see it");
  assert.equal(sessionVisible("chat", "d1"), false, "a dock chat does not leak into the Chat section");
});
