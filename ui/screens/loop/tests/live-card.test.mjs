import { test } from "node:test";
import assert from "node:assert/strict";
import { liveCardNote } from "../native/live-card.ts";

test("the live card note names the model only while an agent step runs", () => {
  assert.equal(liveCardNote({ model: "Opus 5.5" }), "Running now · Opus 5.5");
  assert.equal(liveCardNote({ model: null }), "Running now");
  assert.equal(liveCardNote({}), "Running now");
});
