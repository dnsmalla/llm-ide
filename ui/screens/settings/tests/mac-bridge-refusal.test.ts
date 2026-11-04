import { test } from "node:test";
import assert from "node:assert/strict";
import { PAIR_AGAIN, refusalText } from "../../bridge/mac-bridge.ts";

// Security review bridge-3006: the Mac grants the desktop class at pairing. A phone-class record (or a refused
// pairing) is told how to fix it instead of a bare "only available on your Mac".
test("a desktop_only refusal tells the desktop app to pair again", () => {
  assert.equal(refusalText("desktop_only", "This is only available on your Mac."), PAIR_AGAIN);
  assert.match(PAIR_AGAIN, /Pair again from Settings → Mobile Bridge to allow Auto Tasks control/);
});

test("a refused desktop pairing keeps the Mac's own message", () => {
  const m = "Your Mac did not allow Auto Tasks control. Pair again from Settings → Mobile Bridge to allow Auto Tasks control.";
  assert.equal(refusalText("desktop_denied", m), m);
  assert.equal(refusalText("desktop_denied", null), PAIR_AGAIN);
});

test("other refusals pass through", () => {
  assert.equal(refusalText("tier_refused", "nope"), "nope");
  assert.equal(refusalText(null, null), "The Mac refused that request.");
});
