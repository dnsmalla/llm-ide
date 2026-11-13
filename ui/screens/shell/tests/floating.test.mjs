import { test } from "node:test";
import assert from "node:assert/strict";
import { placeFloating } from "../floating-place.ts";

const r = (top, left, w, h) => ({ top, left, right: left + w, bottom: top + h });

test("a popup opens below its button, aligned to the button's start", () => {
  assert.deepEqual(placeFloating(r(100, 200, 80, 24), { width: 300, height: 200 }, 1400, 900), { top: 130, left: 200, maxHeight: 900 - 124 - 6 - 8, side: "below" });
});

test("end alignment keeps the popup inside a narrow right-hand pane (Route history in the Code Assistant)", () => {
  const p = placeFloating(r(60, 1200, 100, 24), { width: 320, height: 200 }, 1400, 900, "below-end");
  assert.equal(p.left, 1300 - 320);
  // Start alignment near the right edge slides back inside the window instead of spilling off it.
  assert.equal(placeFloating(r(60, 1300, 90, 24), { width: 320, height: 200 }, 1400, 900).left, 1400 - 8 - 320);
  // Near the left edge it never goes past the margin.
  assert.equal(placeFloating(r(60, 2, 40, 24), { width: 320, height: 200 }, 1400, 900, "below-end").left, 8);
});

test("no room below (a status-bar or composer button): it opens above; it never grows taller than its side's room", () => {
  const p = placeFloating(r(860, 100, 80, 24), { width: 300, height: 400 }, 1400, 900);
  assert.equal(p.side, "above");
  assert.equal(p.top, 860 - 6 - 400);
  const tall = placeFloating(r(860, 100, 80, 24), { width: 300, height: 2000 }, 1400, 900);
  assert.equal(tall.maxHeight, 860 - 6 - 8);
  assert.equal(tall.top, 8);
  // Asked to open above with no room there, it opens below.
  assert.equal(placeFloating(r(20, 100, 80, 24), { width: 300, height: 200 }, 1400, 900, "above-start").side, "below");
});
