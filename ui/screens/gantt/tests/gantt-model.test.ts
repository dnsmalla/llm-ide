import { test } from "node:test";
import assert from "node:assert/strict";
import { barGeometry, buildRows, dayNumber, dayString, decodeSchedules, isWeekend, span, timelineRange, undatedRows } from "../gantt-model.ts";

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
