import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadChat } from "./helpers.mjs";

let c;
before(async () => { c = await loadChat("virtual"); });

test("offsets: measured heights win, unmeasured use the estimate", () => {
  const o = c.buildOffsets([10, undefined, 30], 3, 100);
  assert.deepEqual([...o], [0, 10, 110, 140]);
});

test("window covers the viewport plus overscan and pads the rest", () => {
  const o = c.buildOffsets([], 1000, 50); // 50k px
  const w = c.computeWindow(o, 5000, 500, 2);
  assert.equal(w.start, 98);               // item 100 at 5000, minus 2
  assert.equal(w.end, 113);                // last visible 110, +1 +2
  assert.equal(w.padTop, 98 * 50);
  assert.equal(w.padBottom, 50000 - 113 * 50);
  assert.equal(w.total, 50000);
});

test("rendered node count is bounded for huge lists, at any scroll position", () => {
  const o = c.buildOffsets([], 100_000, 44);
  for (const top of [0, 1e6, 2_200_000, 4_399_000, 9e9]) {
    const w = c.computeWindow(o, top, 700, 6);
    assert.ok(w.end - w.start <= 16 + 13, `${top}: ${w.end - w.start}`);
    assert.ok(w.end > w.start);
  }
});

test("clamps: empty list, scroll past the end, viewport larger than content", () => {
  assert.deepEqual(c.computeWindow(c.buildOffsets([], 0, 10), 0, 100), { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 });
  const o = c.buildOffsets([], 3, 10);
  assert.deepEqual([c.computeWindow(o, 9999, 20, 0).start, c.computeWindow(o, 9999, 20, 0).end], [1, 3]);
  const all = c.computeWindow(o, 0, 5000, 0);
  assert.deepEqual([all.start, all.end, all.padTop, all.padBottom], [0, 3, 0, 0]);
});

test("indexAt is a binary search over variable heights", () => {
  const o = c.buildOffsets([5, 100, 5, 100], 4, 1);
  assert.equal(c.indexAt(o, 0), 0);
  assert.equal(c.indexAt(o, 5), 1);
  assert.equal(c.indexAt(o, 104), 1);
  assert.equal(c.indexAt(o, 105), 2);
  assert.equal(c.indexAt(o, 9999), 3);
});

test("prepend keeps the anchor: scroll adjusts by the height of the added items", () => {
  const o = c.buildOffsets([10, 20, 30, 40], 4, 1);
  assert.equal(c.prependScrollAdjust(o, 2), 30);
  assert.equal(c.prependScrollAdjust(o, 0), 0);
});

test("follow-the-stream and load-older triggers", () => {
  assert.equal(c.isNearBottom(900, 100, 1000), true);
  assert.equal(c.isNearBottom(500, 100, 1000), false);
  assert.equal(c.shouldLoadOlder(10), true);
  assert.equal(c.shouldLoadOlder(1000), false);
});

test("session groups: labels by age, headers only on change, fixed heights", () => {
  const now = new Date(2026, 9, 31, 15, 0, 0).getTime();
  const day = 86_400_000;
  assert.equal(c.groupLabel(now - 3600_000, now), "Today");
  assert.equal(c.groupLabel(now - day, now), "Yesterday");
  assert.equal(c.groupLabel(now - 3 * day, now), "Previous 7 days");
  assert.equal(c.groupLabel(now - 20 * day, now), "Previous 30 days");
  assert.match(c.groupLabel(now - 90 * day, now), /^\d{4}-\d{2}$/);
  const items = [{ id: "a", t: now }, { id: "b", t: now - 1000 }, { id: "c", t: now - 3 * day }];
  const rows = c.groupRows(items, (i) => i.t, (i) => i.id, now);
  assert.deepEqual(rows.map((r) => r.kind), ["header", "item", "item", "header", "item"]);
  assert.deepEqual(c.rowHeights(rows), [28, 44, 44, 28, 44]);
});
