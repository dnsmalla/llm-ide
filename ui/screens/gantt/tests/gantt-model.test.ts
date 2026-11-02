import { test } from "node:test";
import assert from "node:assert/strict";
import { barGeometry, buildRows, countCategories, dayNumber, dayString, decodeSchedules, dependencyLines, filterRows, isSaveShortcut, isWeekend, localToday, rowCategory, span, timelineRange, todayScrollLeft, undatedRows } from "../gantt-model.ts";

const issue = (over: Record<string, unknown> = {}) => ({
  id: String(over.number ?? 1), title: "T", body: "", url: "", provider: "github", repo: "o/r",
  number: 1, state: "open", labels: [], author: null, createdAt: null, updatedAt: null, isPR: false, ...over,
});
const sched = (over: Record<string, unknown> = {}) => ({
  provider: "github", repo: "o/r", issueNumber: 1, startDate: null, dueDate: null, estimateDays: null, dependsOn: [], ...over,
});

test("day numbers round-trip and malformed input is rejected", () => {
  assert.equal(dayString(dayNumber("2026-10-31")!), "2026-10-31");
  assert.equal(dayNumber("2026-13-01"), null);
  assert.equal(dayNumber("yesterday"), null);
});

test("span: dates win; one date + estimate fills the other; one date alone is one day", () => {
  assert.deepEqual(span(null), { start: null, end: null });
  assert.deepEqual(span(sched({ startDate: "2026-01-05", dueDate: "2026-01-07" })), { start: 20458, end: 20460 });
  assert.deepEqual(span(sched({ startDate: "2026-01-05", estimateDays: 3 })), { start: 20458, end: 20460 });
  assert.deepEqual(span(sched({ dueDate: "2026-01-07", estimateDays: 2 })), { start: 20459, end: 20460 });
  assert.deepEqual(span(sched({ dueDate: "2026-01-07" })), { start: 20460, end: 20460 });
  assert.deepEqual(span(sched({ startDate: "2026-01-09", dueDate: "2026-01-07" })), { start: 20460, end: 20462 }, "reverse dates swap");
});

test("decode drops rows without a repo/number and keeps null dates", () => {
  const out = decodeSchedules({ schedules: [
    sched({ issueNumber: 2, startDate: "2026-01-01", dependsOn: [3, 0, "x", 3] }),
    sched({ repo: "" }),
    sched({ issueNumber: 0 }),
    "bad",
  ] });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]!.dependsOn, [3]);
  assert.equal(out[0]!.startDate, "2026-01-01");
});

test("rows merge by provider/repo/number, skip PRs, and sort dated before undated", () => {
  const issues = [issue({ number: 1, title: "a" }), issue({ number: 2, title: "b" }), issue({ number: 3, isPR: true }), issue({ number: 4, provider: "gitlab" })];
  const schedules = [sched({ issueNumber: 1, startDate: "2026-01-02", dueDate: "2026-01-03" }), sched({ issueNumber: 2 })];
  const rows = buildRows(issues, schedules, "github", "o/r");
  assert.deepEqual(rows.map((r) => r.issue.number), [1, 2]);
  assert.equal(rows[0]!.start !== null, true);
  assert.equal(rows[1]!.start, null);
  assert.deepEqual(undatedRows(rows).map((r) => r.issue.number), [2]);
});

test("range covers every bar padded and is today-centred when nothing is dated", () => {
  const rows = buildRows([issue({ number: 1 }), issue({ number: 2 })], [sched({ issueNumber: 1, startDate: "2026-01-05", dueDate: "2026-01-07" })], "github", "o/r");
  const range = timelineRange(rows, 20450);
  assert.ok(range.start <= 20458 && range.start + range.days - 1 >= 20460);
  assert.ok(range.days >= 21);
  assert.deepEqual(timelineRange([], 20450), { start: 20443, days: 21 });
});

test("bar geometry clamps to the range and never goes negative", () => {
  const rows = buildRows([issue({ number: 1 })], [sched({ issueNumber: 1, startDate: "2026-01-05", dueDate: "2026-01-07" })], "github", "o/r");
  const row = rows[0]!;
  const g = barGeometry(row, { start: row.start!, days: 10 }, 10)!;
  assert.equal(g.left, 0);
  assert.equal(g.width, 30);
  assert.equal(barGeometry(row, { start: row.start! + 20, days: 10 }, 10), null);
  assert.equal(isWeekend(dayNumber("2026-01-03")!), true, "2026-01-03 is a Saturday");
});

import { issueLabel, issueTitleBody } from "../gantt-model.ts";

test("issue labels do not duplicate a title's existing #number", () => {
  assert.equal(issueTitleBody({ number: 24, title: "#24 InboxStore: no concurrency protection" }), "InboxStore: no concurrency protection");
  assert.equal(issueLabel({ number: 24, title: "#24 InboxStore: no concurrency protection" }), "#24 InboxStore: no concurrency protection");
  assert.equal(issueLabel({ number: 30, title: "After creating an issue" }), "#30 After creating an issue");
});

test("legend category: closed wins, then overdue by end day, else open", () => {
  const today = dayNumber("2026-11-02")!;
  const mk = (state: string, end: string | null) => ({ issue: issue({ state }), end: end ? dayNumber(end) : null }) as never;
  assert.equal(rowCategory(mk("closed", "2026-01-01"), today), "closed");
  assert.equal(rowCategory(mk("open", "2026-11-01"), today), "overdue");
  assert.equal(rowCategory(mk("open", "2026-11-02"), today), "open");
  assert.equal(rowCategory(mk("open", null), today), "open");
  assert.deepEqual(countCategories([mk("closed", null), mk("open", "2026-10-01"), mk("open", null)] as never, today), { open: 1, closed: 1, overdue: 1 });
});

test("filterRows applies label, legend and date-range filters like the Mac", () => {
  const today = dayNumber("2026-11-02")!;
  const r = (number: number, labels: string[], s: string | null, e: string | null, createdAt: string | null = null) =>
    ({ issue: issue({ number, labels, createdAt }), schedule: null, start: s ? dayNumber(s) : null, end: e ? dayNumber(e) : null, dependsOn: [] });
  const rows = [
    r(1, ["bug"], "2026-11-01", "2026-11-05"),
    r(2, ["feat"], "2026-12-01", "2026-12-05"),
    r(3, ["bug"], null, null, "2026-10-20T00:00:00Z"),
    r(4, [], "2026-10-01", "2026-10-03"),
  ];
  const all = ["open", "closed", "overdue"] as const;
  const base = { label: "", categories: all, from: null, until: null, today };
  assert.deepEqual(filterRows(rows, base).map((x) => x.issue.number), [1, 2, 3, 4]);
  assert.deepEqual(filterRows(rows, { ...base, label: "bug" }).map((x) => x.issue.number), [1, 3]);
  assert.deepEqual(filterRows(rows, { ...base, categories: ["overdue"] }).map((x) => x.issue.number), [4]);
  // Range Nov 1..Nov 30: #4 (ends Oct 3) drops, #2 (starts Dec 1) drops, #3 is placed by its creation day (Oct 20) and drops.
  assert.deepEqual(filterRows(rows, { ...base, from: dayNumber("2026-11-01")!, until: dayNumber("2026-11-30")! }).map((x) => x.issue.number), [1]);
});

test("dependency arrows run from the blocker's end to the dependent's start, skipping hidden or undated blockers", () => {
  const range = { start: dayNumber("2026-11-01")!, days: 21 };
  const row = (number: number, s: string | null, e: string | null, dependsOn: number[] = []) =>
    ({ issue: issue({ number }), schedule: null, start: s ? dayNumber(s) : null, end: e ? dayNumber(e) : null, dependsOn });
  const rows = [row(1, "2026-11-01", "2026-11-03"), row(2, "2026-11-05", "2026-11-08", [1, 9]), row(3, null, null, [1]), row(4, "2026-11-10", "2026-11-12", [2])];
  const lines = dependencyLines(rows, range, 10, (i) => 100 + i * 44);
  assert.deepEqual(lines, [
    { blocker: 1, dependent: 2, x1: 3 * 10, y1: 100, x2: 4 * 10, y2: 144 },
    { blocker: 2, dependent: 4, x1: 8 * 10, y1: 144, x2: 9 * 10, y2: 232 },
  ]);
});

test("today scroll keeps today a third into the viewport, never negative", () => {
  assert.equal(todayScrollLeft(300, 300), 200);
  assert.equal(todayScrollLeft(20, 900), 0);
});

test("the save shortcut is Cmd/Ctrl+Enter only", () => {
  assert.equal(isSaveShortcut({ key: "Enter", metaKey: true, ctrlKey: false }), true);
  assert.equal(isSaveShortcut({ key: "Enter", metaKey: false, ctrlKey: true }), true);
  assert.equal(isSaveShortcut({ key: "Enter", metaKey: false, ctrlKey: false }), false);
  assert.equal(isSaveShortcut({ key: "a", metaKey: true, ctrlKey: false }), false);
});

test("today is the local calendar day, not the UTC day (Mac Calendar.current)", () => {
  // 00:30 local is the previous UTC day east of UTC (Japan); 23:30 local is the next UTC day west of it.
  // The UTC formula fails one of these in any non-UTC zone; run with TZ=Asia/Tokyo to see the first.
  assert.equal(localToday(new Date(2026, 10, 2, 0, 30)), dayNumber("2026-11-02"));
  assert.equal(localToday(new Date(2026, 10, 2, 23, 30)), dayNumber("2026-11-02"));
  // DST change days still map to one calendar day.
  assert.equal(localToday(new Date(2026, 2, 8, 12, 0)), dayNumber("2026-03-08"));
});
