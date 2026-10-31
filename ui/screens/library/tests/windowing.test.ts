import { test } from "node:test";
import assert from "node:assert/strict";
import { scrollToReveal, sectionRanges, sectionsToRender, windowRange } from "../windowing.ts";

test("windowRange renders only the viewport plus overscan, with exact padding", () => {
  const w = windowRange({ total: 50_000, rowHeight: 40, scrollTop: 400_000, viewportHeight: 800, overscan: 8 });
  assert.equal(w.start, 10_000 - 8);
  assert.equal(w.end, 10_000 + 20 + 8);
  assert.ok(w.end - w.start <= 40, "a 50k list renders ~36 rows");
  assert.equal(w.padTop + (w.end - w.start) * 40 + w.padBottom, w.totalHeight);
});

test("windowRange edges: empty, top, bottom, bad numbers", () => {
  assert.deepEqual(windowRange({ total: 0, rowHeight: 40, scrollTop: 0, viewportHeight: 800 }), { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
  const top = windowRange({ total: 100, rowHeight: 10, scrollTop: -50, viewportHeight: 100, overscan: 2 });
  assert.equal(top.start, 0);
  const bottom = windowRange({ total: 100, rowHeight: 10, scrollTop: 99_999, viewportHeight: 100, overscan: 2 });
  assert.equal(bottom.end, 100);
  assert.ok(bottom.start <= bottom.end);
  const nan = windowRange({ total: 10, rowHeight: 0, scrollTop: NaN, viewportHeight: NaN });
  assert.ok(nan.start >= 0 && nan.end <= 10);
});

test("scrollToReveal moves the least", () => {
  assert.equal(scrollToReveal(5, 40, 0, 800), 0);
  assert.equal(scrollToReveal(30, 40, 0, 800), 1200 + 40 - 800);
  assert.equal(scrollToReveal(1, 40, 400, 800), 40);
});

test("progressive sections grow near the end only, never past the total", () => {
  const base = { total: 5, viewportHeight: 600, contentHeight: 3000 };
  assert.equal(sectionsToRender({ ...base, rendered: 1, scrollTop: 0 }), 1);
  assert.equal(sectionsToRender({ ...base, rendered: 1, scrollTop: 2000 }), 2);
  assert.equal(sectionsToRender({ ...base, rendered: 5, scrollTop: 99_999 }), 5);
  assert.deepEqual(sectionRanges(5, 2), [{ start: 0, end: 2 }, { start: 2, end: 4 }, { start: 4, end: 5 }]);
  assert.deepEqual(sectionRanges(0, 10), []);
});
