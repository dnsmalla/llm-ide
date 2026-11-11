// The Gantt body at big-project size (2,000 issues over 365 days): the rendered node count, the render time, the
// windowed row range and focus pinning, and the model functions staying linear. The chart is bundled with desktop's
// esbuild so React resolves to desktop's single copy (the same approach as the settings and shell tests).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleDir } from "../../../../desktop/scripts/test-outdir.mjs";
import { barGeometry, buildRows, dayNumber, dayString, dependencyLines, GANTT_WINDOW_BUFFER, macBounds, timelineRange, visibleRowWindow } from "../gantt-model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GANTT = resolve(HERE, "..");
const DESKTOP = resolve(GANTT, "../../../desktop");
const req = createRequire(join(DESKTOP, "package.json"));
const { createElement: h } = req("react");
const { renderToStaticMarkup } = req("react-dom/server");

let GanttChart;
before(async () => {
  const { build } = req("esbuild");
  const outfile = join(bundleDir("gantt"), "chart.mjs");
  await build({ entryPoints: [join(GANTT, "GanttChart.tsx")], outfile, bundle: true, format: "esm", platform: "node", packages: "external", jsx: "automatic", logLevel: "silent" });
  ({ GanttChart } = await import(pathToFileURL(outfile).href));
});

const TODAY = dayNumber("2026-04-01");

/** `n` issues whose schedules start across `spanDays` days; each depends on the one before it (arrows everywhere). */
function fixture(n, spanDays) {
  const base = dayNumber("2026-01-01");
  const issues = Array.from({ length: n }, (_, k) => ({
    id: `i${k + 1}`, title: `Issue ${k + 1} with a fairly long title for the label`, body: "", url: `https://github.com/o/r/issues/${k + 1}`,
    provider: "github", repo: "o/r", number: k + 1, state: k % 3 === 0 ? "closed" : "open", labels: ["bug"], author: null,
    createdAt: null, updatedAt: null, isPR: false, milestone: null, assignees: [],
  }));
  const schedules = issues.map((_, k) => {
    const start = base + ((k * 37) % spanDays);
    return { provider: "github", repo: "o/r", issueNumber: k + 1, startDate: dayString(start), dueDate: dayString(start + 1 + (k % 10)), estimateDays: null, dependsOn: k > 0 ? [k] : [], updatedAt: null };
  });
  const rows = buildRows(issues, schedules, "github", "o/r");
  return { rows, range: timelineRange(rows, TODAY) };
}

const props = (rows, range, extra = {}) => ({
  rows, shown: rows.length, total: rows.length, noBars: false, range, dayWidth: 12, zoom: "week", today: TODAY,
  selectedId: undefined, onActivate: () => {}, scrollRef: { current: null }, ...extra,
});
const tags = (html) => (html.match(/<[a-zA-Z][a-zA-Z0-9]*/g) ?? []).length;

test("the whole body (all 2,000 rows drawn) stays under 40,000 nodes at 365 days, and renders in under 1.5 s", () => {
  const { rows, range } = fixture(2000, 365);
  assert.equal(rows.length, 2000);
  assert.ok(range.days >= 365 && range.days <= 400, `a one-year range, got ${range.days} days`);
  const t0 = performance.now();
  const html = renderToStaticMarkup(h(GanttChart, props(rows, range, { assumedViewportHeight: 1e7 })));
  const ms = performance.now() - t0;
  const nodes = tags(html);
  assert.ok(nodes < 40_000, `whole body nodes: ${nodes}`);
  assert.ok(ms < 1500, `render took ${ms.toFixed(0)} ms`);
  assert.equal(html.includes('class="gnt-grid"'), false, "no per-row day cells: the day grid is one background layer");
});

test("the windowed body (the default viewport) stays under 6,000 nodes, and only the rows in view are drawn", () => {
  const { rows, range } = fixture(2000, 365);
  const html = renderToStaticMarkup(h(GanttChart, props(rows, range)));
  const nodes = tags(html);
  assert.ok(nodes < 6_000, `windowed nodes: ${nodes}`);
  const drawn = (html.match(/class="gnt-rowlabel"/g) ?? []).length;
  assert.ok(drawn > 0 && drawn < 60, `${drawn} label rows drawn of 2,000`);
  assert.equal((html.match(/class="gnt-track"/g) ?? []).length, drawn, "one track per drawn label");
});

test("the node count grows with the days only by one day header per day (not per row x day)", () => {
  const short = fixture(2000, 365);
  const long = fixture(2000, 730);
  const a = tags(renderToStaticMarkup(h(GanttChart, props(short.rows, short.range, { assumedViewportHeight: 1e7 }))));
  const b = tags(renderToStaticMarkup(h(GanttChart, props(long.rows, long.range, { assumedViewportHeight: 1e7 }))));
  const extraDays = long.range.days - short.range.days;
  assert.ok(extraDays > 300, `the second range is longer by ${extraDays} days`);
  assert.ok(b - a <= extraDays + 40, `extra nodes ${b - a} for ${extraDays} extra days (one header node per day, plus month labels)`);
});

test("a focused row stays rendered when the window moves: the window always includes the pinned row", () => {
  const far = visibleRowWindow({ scrollTop: 0, viewportHeight: 600, headHeight: 52, rowHeight: 44, count: 2000, pinned: 1500 });
  assert.equal(far.extra, 1500, "a pinned row far below the viewport is kept, on its own");
  assert.ok(far.last < 40, `and the range is not stretched to reach it (last ${far.last})`);
  const top = visibleRowWindow({ scrollTop: 0, viewportHeight: 600, headHeight: 52, rowHeight: 44, count: 2000 });
  assert.equal(top.first, 0, "the window starts at the first row at the top");
  assert.ok(top.last >= 12 && top.last <= 12 + GANTT_WINDOW_BUFFER + 2, `a 600px viewport shows about 13 rows plus the buffer, got last ${top.last}`);
  const mid = visibleRowWindow({ scrollTop: 44 * 500, viewportHeight: 600, headHeight: 52, rowHeight: 44, count: 2000 });
  assert.ok(mid.first <= 500 && mid.last >= 512, "the rows under the scrolled viewport are in the window");
  assert.deepEqual(visibleRowWindow({ scrollTop: 0, viewportHeight: 600, headHeight: 52, rowHeight: 44, count: 0 }), { first: 0, last: -1, extra: null });
});

test("the model stays linear: 2,000 vs 4,000 rows take under 3.5x as long (dependency arrows, bounds, geometry, range)", () => {
  const time = (fn) => {
    const samples = [];
    for (let s = 0; s < 5; s++) {
      const t0 = performance.now();
      for (let k = 0; k < 20; k++) fn();
      samples.push(performance.now() - t0);
    }
    return samples.sort((a, b) => a - b)[2];
  };
  const measure = (n) => {
    const { rows, range } = fixture(n, 365);
    return time(() => {
      dependencyLines(rows, range, 12, (i) => 52 + i * 44 + 22);
      for (const r of rows) { macBounds(r); barGeometry(r, range, 12); }
      timelineRange(rows, TODAY);
    });
  };
  const small = measure(2000);
  const big = measure(4000);
  assert.ok(big / Math.max(small, 0.01) < 3.5, `4,000 rows took ${(big / small).toFixed(2)}x the 2,000-row time`);
});

test("the chart source has no per-row day grid, and its one day layer and sticky header are CSS, not nodes", () => {
  const src = readFileSync(join(GANTT, "GanttChart.tsx"), "utf8");
  assert.equal(/className="gnt-grid"/.test(src), false);
  assert.match(src, /gnt-gridlayer/);
  assert.match(src, /repeating-linear-gradient/);
});

const W = (over) => visibleRowWindow({ scrollTop: 0, viewportHeight: 600, headHeight: 52, rowHeight: 44, count: 2000, ...over });

test("visibleRowWindow edge cases: 1 row, fewer rows than the viewport, a tiny viewport, a huge scrollTop, the buffer", () => {
  assert.deepEqual(W({ count: 1 }), { first: 0, last: 0, extra: null });
  assert.deepEqual(W({ count: 5 }), { first: 0, last: 4, extra: null }, "fewer rows than the viewport: all of them");
  const tiny = W({ viewportHeight: 1, scrollTop: 44 * 100 });
  assert.ok(tiny.first <= 98 && tiny.last >= 99 && tiny.last - tiny.first <= 2 * GANTT_WINDOW_BUFFER + 3, `tiny viewport ${JSON.stringify(tiny)}`);
  assert.deepEqual(W({ scrollTop: 1e9 }), { first: 1999, last: 1999, extra: null }, "past the end clamps to the last row");
  assert.equal(W({ scrollTop: -500 }).first, 0, "an overscrolled (negative) scrollTop clamps to the first row");
  const mid = W({ scrollTop: 52 + 44 * 500, viewportHeight: 440 });
  assert.deepEqual([mid.first, mid.last], [500 - GANTT_WINDOW_BUFFER, 510 + GANTT_WINDOW_BUFFER], "rows 500..510 in view, the buffer either side");
  assert.equal(W({ count: 2000, pinned: 3 }).extra, null, "a pinned row already in range is not drawn twice");
  assert.equal(W({ count: 10, pinned: 12 }).extra, null, "a stale pin past the end is ignored");
  assert.equal(W({ count: 10, pinned: -1 }).extra, null);
});

test("the labels are a list that reports each row's place in the whole list (aria-setsize/posinset)", () => {
  const { rows, range } = fixture(2000, 365);
  const html = renderToStaticMarkup(h(GanttChart, props(rows, range)));
  assert.match(html, /role="list"/);
  assert.match(html, /role="listitem" aria-posinset="1" aria-setsize="2000"/);
});

test("every --tok-color token the Gantt uses is defined (an undefined one voids the whole grid gradient)", () => {
  const defined = new Set(readFileSync(resolve(GANTT, "../../kit/src/styles/tokens.generated.css"), "utf8").match(/--tok-color-[a-z0-9-]+(?=:)/g));
  for (const f of ["GanttChart.tsx", "gantt.css", "../issues/issues.css"]) {
    for (const used of readFileSync(join(GANTT, f), "utf8").match(/--tok-color-[a-z0-9-]+/g) ?? []) {
      assert.ok(defined.has(used), `${f} uses undefined ${used}`);
    }
  }
});

test("head and rows are border-box, so HEAD_H (56) and ROW_H (56) are the real heights", () => {
  const css = readFileSync(join(GANTT, "gantt.css"), "utf8");
  const rule = css.match(/\n(\.gnt-months,[^{]*)\{\s*box-sizing: border-box;\s*\}/)?.[1] ?? "";
  for (const c of [".gnt-months", ".gnt-header", ".gnt-labels-head", ".gnt-month-pad", ".gnt-track", ".gnt-day", ".gnt-month"]) {
    assert.ok(rule.split(",").map((x) => x.trim()).includes(c), `${c} is border-box`);
  }
});

test("bars advertise drag only when the chart has a shift handler", () => {
  const { rows, range } = fixture(3, 30);
  const plain = renderToStaticMarkup(h(GanttChart, props(rows, range)));
  assert.match(plain, /Edit schedule/);
  assert.doesNotMatch(plain, /Drag to move/);
  const draggable = renderToStaticMarkup(h(GanttChart, props(rows, range, { onShift: () => {} })));
  assert.match(draggable, /Drag to move; Alt\+Left\/Right for one day/);
});
