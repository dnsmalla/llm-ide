import { test } from "node:test";
import assert from "node:assert/strict";
import { savedProfileNotice } from "../sections/feature-profile-notice.ts";

test("the saved notice keeps the list of dependent features that were turned off", () => {
  const text = savedProfileNotice("Graph, Gantt");
  assert.match(text, /Also turned off: Graph, Gantt\./);
  assert.match(text, /Saved\./);
});

test("without a dropped feature the notice is only the confirmation", () => {
  assert.equal(savedProfileNotice(""), "Saved. The change applies the next time the app opens.");
});
