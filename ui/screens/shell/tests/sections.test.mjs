import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleSectionsFor, isSelectableFor, REMOTE_SECTIONS, REMOTE_GROUP_HIDDEN, LOCAL_ONLY_NOTICE } from "../sections.ts";

test("remote mode lists only the screens that work over a hub", () => {
  assert.deepEqual(visibleSectionsFor("remote").map((s) => s.id), ["welcome", "issues", "gantt", "library", "chat", "settings"]);
  assert.equal(isSelectableFor("explorer", "remote"), false);
  assert.equal(isSelectableFor("chat", "remote"), true);
  assert.equal(isSelectableFor("explorer", "local"), true);
  assert.match(LOCAL_ONLY_NOTICE, /local computer/);
  assert.ok(REMOTE_GROUP_HIDDEN.includes("workspace"));
  assert.deepEqual(REMOTE_SECTIONS, ["welcome", "issues", "gantt", "library", "chat", "settings"]);
});
