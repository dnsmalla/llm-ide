import { test } from "node:test";
import assert from "node:assert/strict";
import { isHubHello, hubCopy, syncEntryVisible } from "../src/hub-copy.ts";

test("a hub host hides offline sync and explains why", () => {
  assert.equal(isHubHello({ hostKind: "hub" }), true);
  assert.equal(isHubHello({ hostKind: "desktop" }), false);
  assert.equal(isHubHello(null), false);
  assert.match(hubCopy({ hostKind: "hub" }), /always-online/);
  assert.equal(hubCopy({ hostKind: "desktop" }), null);
  assert.equal(syncEntryVisible({ hostKind: "hub" }), false);
  assert.equal(syncEntryVisible({ hostKind: "desktop" }), true);
});
