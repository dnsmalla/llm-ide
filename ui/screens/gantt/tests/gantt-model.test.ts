import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_SPAN_DAYS, DETAIL_NESTED_HINT, GANTT_NESTED_HINT, issueDatesView, loadTimeline, readIssueSchedule, GITLAB_LOCAL_DATES_NOTE, localDatesNote, barDates, GANTT_ROW_ACTIONS, canSchedule, estimateSpanDays, macBounds, projectOptions, presetRange, scheduleSaveBody, shiftSchedule, shiftScheduleBody, scheduleBody, enqueueShift, settleShift, dragShift, barGeometry, buildRows, countCategories, dayNumber, dayString, decodeSchedules, dependencyLines, filterRows, fillRange, isSaveShortcut, isWeekend, localToday, rowCategory, span, timelineRange, todayScrollLeft, undatedRows } from "../gantt-model.ts";

const issue = (over: Record<string, unknown> = {}) => ({
  id: String(over.number ?? 1), title: "T", body: "", url: "", provider: "github", repo: "o/r",
  number: 1, state: "open", labels: [], author: null, createdAt: null, updatedAt: null, isPR: false, milestone: null, assignees: [], ...over,
});
const sched = (over: Record<string, unknown> = {}) => ({
  provider: "github", repo: "o/r", issueNumber: 1, startDate: null, dueDate: null, estimateDays: null, dependsOn: [], ...over,
});

test("day numbers round-trip and malformed input is rejected", () => {
  assert.equal(dayString(dayNumber("2026-10-31")!), "2026-10-31");
  assert.equal(dayNumber("2026-13-01"), null);
  assert.equal(dayNumber("yesterday"), null);
});

test("span: dates win; one date + estimate fills the other; one date alone spans the Mac's 7 days", () => {
  assert.deepEqual(span(null), { start: null, end: null });
  // Mac GanttView.swift:801-802: lenD = days(startOfDay(s), startOfDay(e)) = 2, so Jan 5 and Jan 6 are drawn, not Jan 7.
  assert.deepEqual(span(sched({ startDate: "2026-01-05", dueDate: "2026-01-07" })), { start: 20458, end: 20459 });
  assert.deepEqual(span(sched({ startDate: "2026-01-05", estimateDays: 3 })), { start: 20458, end: 20460 });
  // GanttViewModel.swift:202-203 startDate = due - 2 days (Jan 5); GanttView.swift:801-802 draws 2 days, Jan 5 and Jan 6.
  assert.deepEqual(span(sched({ dueDate: "2026-01-07", estimateDays: 2 })), { start: 20458, end: 20459 });
  // GanttViewModel.defaultSpanDays = 7: the bar is 7 days, not 1. Due-only: startDate = due - 7 (Dec 31,
  // GanttViewModel.swift:202-203), drawn to the day before the due day (Jan 6, GanttView.swift:801-802).
  assert.deepEqual(span(sched({ dueDate: "2026-01-07" })), { start: 20453, end: 20459 });
  assert.deepEqual(span(sched({ startDate: "2026-01-05" })), { start: 20458, end: 20464 });
  assert.equal(DEFAULT_SPAN_DAYS, 7);
  // Reversed dates (written by something other than the editor) draw as the Mac does: a one-day bar at the start.
  assert.deepEqual(span(sched({ startDate: "2026-01-09", dueDate: "2026-01-07" })), { start: 20462, end: 20462 }, "reversed dates are not swapped");
});

test("estimates: the Mac truncates a start-anchored estimate and rounds a due-anchored one up, never below one day", () => {
  const d = (over: Record<string, unknown>) => span(sched(over));
  // Start-anchored (Mac: startOfDay(start + est)): 0.5 -> 1 day, 1.9 -> 1, 2.5 -> 2, 364.9 -> 364.
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: 0.5 }), { start: 20458, end: 20458 });
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: 1.9 }), { start: 20458, end: 20458 });
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: 2.5 }), { start: 20458, end: 20459 });
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: 364.9 }), { start: 20458, end: 20458 + 363 });
  // Due-anchored (Mac: startOfDay(due - est)): 1.9 -> 2 days, 2.5 -> 3 days, ending the day before the due day
  // (GanttView.swift:801-802 does not draw the end day).
  assert.deepEqual(d({ dueDate: "2026-01-07", estimateDays: 1.9 }), { start: 20458, end: 20459 });
  assert.deepEqual(d({ dueDate: "2026-01-07", estimateDays: 2.5 }), { start: 20457, end: 20459 });
  // 0 is "no estimate" in the editor; a stored 0 still draws the Mac's one day, not the 7-day default.
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: 0 }), { start: 20458, end: 20458 });
  assert.equal(estimateSpanDays(0.2, "due"), 1);
  // Negative and NaN estimates are never stored (decode drops them) so they fall back to the default span.
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: Number.NaN }), { start: 20458, end: 20464 });
  assert.deepEqual(d({ startDate: "2026-01-05", estimateDays: -1 }), { start: 20458, end: 20464 });
});

test("estimate input: 0..365 in halves or finer, 0 saved as none; out of range, negative and NaN rejected", () => {
  const key = { provider: "github", repo: "o/r", issueNumber: 7 };
  const draft = (estimate: string) => ({ start: "2026-01-05", due: "", estimate, depends: "" });
  const kept = (estimate: string) => {
    const r = scheduleSaveBody(draft(estimate), key);
    return r.ok ? r.body.estimateDays : r.error;
  };
  assert.equal(kept("0.5"), 0.5);
  assert.equal(kept("1.9"), 1.9, "the input is kept as typed; the bar truncates it (Mac)");
  assert.equal(kept("364.9"), 364.9);
  assert.equal(kept("365"), 365);
  assert.equal(kept("0"), null);
  assert.equal(kept(""), null);
  assert.equal(kept("365.1"), "Estimate must be between 0 and 365 days.");
  assert.equal(kept("-0.5"), "Estimate must be between 0 and 365 days.");
  assert.equal(kept("NaN"), "Estimate must be between 0 and 365 days.");
  assert.equal(kept("Infinity"), "Estimate must be between 0 and 365 days.");
});

test("a GitLab schedule is an overlay row like a GitHub one (the core accepts provider gitlab)", () => {
  const rows = decodeSchedules({ schedules: [{ provider: "gitlab", repo: "acme/web", issueNumber: 3, startDate: "2026-01-05", dueDate: null, estimateDays: null, dependsOn: [] }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.provider, "gitlab");
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
  assert.deepEqual(timelineRange([], 20450), { start: 20436, days: 45 });
  assert.deepEqual(fillRange({ start: 1, days: 21 }, 1000, 14), { start: 1, days: 72 });
  assert.deepEqual(fillRange({ start: 1, days: 90 }, 1000, 14), { start: 1, days: 90 });
});

test("bar geometry clamps to the range and never goes negative", () => {
  const rows = buildRows([issue({ number: 1 })], [sched({ issueNumber: 1, startDate: "2026-01-05", dueDate: "2026-01-07" })], "github", "o/r");
  const row = rows[0]!;
  const g = barGeometry(row, { start: row.start!, days: 10 }, 10)!;
  assert.equal(g.left, 0);
  // Jan 5 to Jan 7 is 2 days wide on the Mac (GanttView.swift:801-806: width = lenD * dayWidth, lenD = 2).
  assert.equal(g.width, 20);
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

test("project picker: saved repos and cached repos, de-duplicated, searched, current choice kept", () => {
  const saved = ["acme/web", "acme/api"];
  const cached = ["acme/api", "other/tool"];
  assert.deepEqual(projectOptions(saved, cached, "", ""), ["acme/api", "acme/web", "other/tool"]);
  assert.deepEqual(projectOptions(saved, cached, "  WEB ", ""), ["acme/web"]);
  assert.deepEqual(projectOptions(saved, cached, "zzz", "other/tool"), ["other/tool"], "the current choice stays visible");
  assert.deepEqual(projectOptions([], [], "", ""), []);
});

test("schedule editor save rules: due before start is rejected, bad dates/deps/estimate are rejected, valid input is the PUT body", () => {
  const key = { provider: "github", repo: "o/r", issueNumber: 7 };
  const draft = (over: Partial<{ start: string; due: string; estimate: string; depends: string }> = {}) => ({ start: "", due: "", estimate: "", depends: "", ...over });
  assert.deepEqual(scheduleSaveBody(draft({ start: "2026-01-09", due: "2026-01-07" }), key), { ok: false, error: "Due date must be on or after the start date." });
  assert.deepEqual(scheduleSaveBody(draft({ start: "2026-01-07", due: "2026-01-07" }), key).ok, true, "same-day is allowed");
  assert.deepEqual(scheduleSaveBody(draft({ start: "2026-13-01" }), key), { ok: false, error: "Dates are YYYY-MM-DD or empty." });
  assert.deepEqual(scheduleSaveBody(draft({ depends: "3, x" }), key), { ok: false, error: "Dependencies must be issue numbers, separated by commas." });
  assert.deepEqual(scheduleSaveBody(draft({ depends: "0" }), key), { ok: false, error: "Dependencies must be issue numbers, separated by commas." });
  assert.deepEqual(scheduleSaveBody(draft({ estimate: "-1" }), key), { ok: false, error: "Estimate must be between 0 and 365 days." });
  assert.deepEqual(scheduleSaveBody(draft({ estimate: "366" }), key), { ok: false, error: "Estimate must be between 0 and 365 days." });
  const zero = scheduleSaveBody(draft({ start: "2026-01-05", estimate: "0" }), key);
  assert.equal(zero.ok && zero.body.estimateDays, null, "0 is saved as no estimate (Mac), so the bar keeps the 7-day default");
  assert.deepEqual(scheduleSaveBody(draft({ start: "2026-01-05", due: "2026-01-07", estimate: "2.5", depends: "#4, 4, 9" }), key), {
    ok: true,
    body: { ...key, startDate: "2026-01-05", dueDate: "2026-01-07", estimateDays: 2.5, dependsOn: [4, 9] },
  });
  assert.deepEqual(scheduleSaveBody(draft(), key), { ok: true, body: { ...key, startDate: null, dueDate: null, estimateDays: null, dependsOn: [] } });
});

test("one-date schedules: overdue and the date-range filter use the Mac's endDate (start + estimate or 7), not the inclusive drawn end", () => {
  // Mac GanttViewModel: startDate-only → endDate = start + (estimateDays ?? 7) days; overdue when endDate < today's start.
  const start = "2026-10-20";
  const row = (over: Record<string, unknown>) => {
    const schedule = sched(over);
    const { start: s, end: e } = span(schedule as never);
    return { issue: issue(), schedule, start: s, end: e, dependsOn: [] } as never;
  };
  const startOnly = row({ startDate: start });
  assert.deepEqual(macBounds(startOnly), { start: dayNumber(start), end: dayNumber("2026-10-27") });
  // Drawn bar ends Oct 26 (7 inclusive days); on Oct 27 the Mac still says open, on Oct 28 overdue.
  assert.equal(rowCategory(startOnly, dayNumber("2026-10-27")!), "open");
  assert.equal(rowCategory(startOnly, dayNumber("2026-10-28")!), "overdue");
  // Estimate 3 from Oct 20: Mac end Oct 23.
  assert.equal(rowCategory(row({ startDate: start, estimateDays: 3 }), dayNumber("2026-10-23")!), "open");
  assert.equal(rowCategory(row({ startDate: start, estimateDays: 3 }), dayNumber("2026-10-24")!), "overdue");
  // Due-only: Mac end is the due day itself; start is due − 7.
  const dueOnly = row({ dueDate: "2026-10-27" });
  assert.deepEqual(macBounds(dueOnly), { start: dayNumber("2026-10-20"), end: dayNumber("2026-10-27") });
  assert.equal(rowCategory(dueOnly, dayNumber("2026-10-27")!), "open");
  assert.equal(rowCategory(dueOnly, dayNumber("2026-10-28")!), "overdue");
  // From filter on Oct 27: the Mac keeps the start-only row (endDate Oct 27 is not before it).
  const base = { label: "", categories: ["open", "closed", "overdue"] as const, until: null, today: dayNumber("2026-10-01")! };
  assert.equal(filterRows([startOnly], { ...base, from: dayNumber("2026-10-27")! }).length, 1);
  assert.equal(filterRows([startOnly], { ...base, from: dayNumber("2026-10-28")! }).length, 0);
  // Until filter on Oct 20: the Mac keeps the due-only row (startDate Oct 20 is not after it).
  assert.equal(filterRows([dueOnly], { ...base, from: null, until: dayNumber("2026-10-20")! }).length, 1);
  assert.equal(filterRows([dueOnly], { ...base, from: null, until: dayNumber("2026-10-19")! }).length, 0);
});

test("Gantt row click opens the issue details (Mac GanttView row tap); the bar opens the schedule editor", () => {
  assert.equal(GANTT_ROW_ACTIONS.label, "details");
  assert.equal(GANTT_ROW_ACTIONS.bar, "schedule");
});

test("dependency arrows paint over the grid but under the bars, and never take clicks", () => {
  const css = readFileSync(new URL("../gantt.css", import.meta.url), "utf8");
  const z = (sel: string) => {
    const rules = [...css.matchAll(new RegExp(`^\\${sel}\\s*\\{([^}]*)\\}`, "gm"))].map((m) => m[1]!);
    const hit = rules.map((r) => /z-index:\s*(-?\d+)/.exec(r)).filter(Boolean).pop();
    return hit ? Number(hit[1]) : null;
  };
  const deps = z(".gnt-deps");
  const bar = z(".gnt-bar");
  // Tracks are positioned with z-index auto, so the svg must be > 0 to clear their opaque weekend cells.
  assert.ok(deps !== null && deps > 0, "arrows above the grid tracks");
  assert.ok(bar !== null && bar > deps!, "bars above the arrows");
  assert.match(css, /\.gnt-deps\s*\{[^}]*pointer-events:\s*none/);
});

test("GitLab rows get the Dates section and the Gantt bar, nested groups included; PR-less numberless rows and GitHub nested paths do not", () => {
  assert.equal(canSchedule({ provider: "github", repo: "acme/web", number: 4 }), true);
  assert.equal(canSchedule({ provider: "gitlab", repo: "acme/web", number: 4 }), true, "the core's overlay accepts provider gitlab");
  assert.equal(canSchedule({ provider: "gitlab", repo: "acme/platform/web", number: 4 }), true, "the core keys GitLab paths of 2 to 20 segments");
  assert.equal(canSchedule({ provider: "github", repo: "acme/platform/web", number: 4 }), false, "GitHub is owner/name only");
  assert.equal(canSchedule({ provider: "github", repo: "acme/web", number: null }), false);
  assert.equal(canSchedule({ provider: "bitbucket", repo: "acme/web", number: 4 }), false);
});

test("reversed dates: drawn as a one-day bar at the start, but overdue and the range filter read the due date (Mac endDate)", () => {
  const rows = buildRows([issue({ number: 1 })], [{ provider: "github", repo: "o/r", issueNumber: 1, startDate: "2026-01-09", dueDate: "2026-01-07", estimateDays: null, dependsOn: [], updatedAt: null }], "github", "o/r");
  assert.deepEqual({ start: rows[0]!.start, end: rows[0]!.end }, { start: 20462, end: 20462 });
  assert.deepEqual(macBounds(rows[0]!), { start: 20462, end: 20460 });
  const jan8 = 20461;
  assert.equal(rowCategory(rows[0]!, jan8), "overdue", "due Jan 7 is past on Jan 8, as on the Mac");
  assert.equal(filterRows(rows, { label: "", categories: ["open", "closed", "overdue"], from: jan8, until: null, today: jan8 }).length, 0, "Mac: due before the range start drops the row");
});

test("bar placement follows the Mac's end-exclusive rule; arrows stay on the drawn bar ends (review F5)", () => {
  // GanttView.swift:797-811: x = offD(startOfDay(s)), width = max(1, days(startOfDay(s), startOfDay(e))) days.
  const d = (over: Record<string, unknown>) => span(sched(over));
  assert.deepEqual(d({ startDate: "2026-01-07", dueDate: "2026-01-07" }), { start: 20460, end: 20460 }, "same day: max(1, 0) = one day");
  assert.deepEqual(d({ startDate: "2026-01-05", dueDate: "2026-01-06" }), { start: 20458, end: 20458 }, "one day apart: one day");
  assert.deepEqual(d({ dueDate: "2026-01-07", estimateDays: 0 }), { start: 20460, end: 20460 }, "a stored 0: startDate = due, one day on the due day");
  assert.deepEqual(d({ dueDate: "2026-01-07", estimateDays: 0.2 }), { start: 20459, end: 20459 }, "startOfDay(due - 0.2) is the day before");
  // The Mac's endDate (overdue, range filter) is still the due date even though the bar stops the day before.
  const rows = buildRows(
    [issue({ number: 1 }), issue({ number: 2 })],
    [sched({ issueNumber: 1, startDate: "2026-01-05", dueDate: "2026-01-07" }), sched({ issueNumber: 2, dueDate: "2026-01-14", dependsOn: [1] })],
    "github", "o/r",
  );
  assert.deepEqual(rows.map((r) => [r.start, r.end]), [[20458, 20459], [20460, 20466]]);
  assert.deepEqual(macBounds(rows[0]!), { start: 20458, end: 20460 });
  assert.equal(rowCategory(rows[0]!, 20460), "open", "due Jan 7 is open on Jan 7");
  assert.equal(rowCategory(rows[0]!, 20461), "overdue");
  assert.equal(barDates(rows[0]!), "2026-01-05 → 2026-01-07", "the tooltip shows the schedule's dates, not the drawn days");
  assert.equal(barDates(rows[1]!), "2026-01-07 → 2026-01-14");
  const range = { start: 20458, days: 21 };
  const [line] = dependencyLines(rows, range, 10, (i) => i);
  // Blocker trailing anchor = x + width (Jan 7's left edge); dependent leading anchor = its x (Jan 7, due - 7).
  assert.deepEqual(line, { blocker: 1, dependent: 2, x1: 20, y1: 0, x2: 20, y2: 1 });
  const g = barGeometry(rows[1]!, range, 10)!;
  assert.deepEqual([g.left, g.width], [20, 70], "due-only default: 7 days from due - 7");
});

test("GitLab dates are labelled as kept on this computer in the editor and the Dates section; GitHub dates are not (review F4)", () => {
  // Mac: GitLabClient+RepoBackend.swift:14 usesScheduleOverlay = false; RepoIssueDetailSheet.swift:463 edits GitLab's own due date.
  assert.equal(localDatesNote({ provider: "gitlab" }), "Saved on this computer only. It is not sent to GitLab.");
  assert.equal(GITLAB_LOCAL_DATES_NOTE, "Saved on this computer only. It is not sent to GitLab.");
  assert.equal(localDatesNote({ provider: "github" }), null);
  // Both places that show or edit a row's dates render the note from the row's provider.
  for (const file of ["../ScheduleEditor.tsx", "../../issues/IssueDetail.tsx"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(src, /\{localDatesNote\(issue\) \? <p className="(gnt|iss)-hint" role="note">\{localDatesNote\(issue\)\}<\/p> : null\}/, file);
  }
  // In IssueDetail the note sits inside the Dates section, right under its heading.
  const detail = readFileSync(new URL("../../issues/IssueDetail.tsx", import.meta.url), "utf8");
  assert.match(detail, /<h3 className="iss-col-title">Dates<\/h3>\s*\{localDatesNote\(issue\)/);
});

test("Gantt load: a nested GitLab project reads its overlay; a GitHub nested path skips it with the hint; a failed load or a retry never keeps it (review F7)", async () => {
  const calls: string[] = [];
  const ok = (body: unknown) => ({ status: 200, body });
  const fake = (mode: "ok" | "throw" | "500") => async (_m: "GET", path: string) => {
    calls.push(path);
    if (mode === "throw") throw new Error("offline");
    if (mode === "500") return { status: 500, body: null };
    return path.startsWith("/kb/issues") ? ok({ issues: [issue({ provider: "gitlab", repo: "acme/platform/web" })] }) : ok({ schedules: [] });
  };
  const nested = await loadTimeline(fake("ok"), "gitlab", "acme/platform/web");
  assert.equal(nested.ok, true);
  assert.equal(nested.nestedHint, false);
  assert.equal(calls.includes("/kb/issue-schedule?provider=gitlab&repo=acme%2Fplatform%2Fweb"), true, "a nested GitLab path is keyed by the core");
  calls.length = 0;
  const gh = await loadTimeline(fake("ok"), "github", "acme/platform/web");
  assert.equal(gh.ok, true);
  assert.equal(gh.nestedHint, true);
  assert.equal(calls.some((c) => c.startsWith("/kb/issue-schedule")), false, "no overlay GET for a GitHub 3-part path (the core answers 400)");
  calls.length = 0;
  const flat = await loadTimeline(fake("ok"), "gitlab", "acme/web");
  assert.equal(flat.nestedHint, false);
  assert.deepEqual(calls, ["/kb/issues?provider=gitlab&state=all&limit=100", "/kb/issue-schedule?provider=gitlab&repo=acme%2Fweb"]);
  const all = await loadTimeline(fake("ok"), "gitlab", "");
  assert.equal(all.nestedHint, false, "All repositories reads the whole provider overlay");
  // A network error or a failed status on a nested project never carries the hint, so the retry starts clean.
  const offline = await loadTimeline(fake("throw"), "gitlab", "acme/platform/web");
  assert.deepEqual(offline, { ok: false, nestedHint: false, error: "The core is not reachable right now." });
  const failed = await loadTimeline(fake("500"), "gitlab", "acme/platform/web");
  assert.equal(failed.nestedHint, false);
  // The screen clears the hint before each load and sets it only from the result.
  const screen = readFileSync(new URL("../GanttScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /setNestedNote\(false\);\s*const inView = /, "cleared before every read");
  assert.match(screen, /loadScopeTimeline\(deps\.request, \{ providers: repoScope\.providers, repo \}/);
  assert.match(screen, /setNestedNote\(r\.nestedHint\);/);
  assert.equal((screen.match(/setNestedNote\(/g) ?? []).length, 2, "no other write can leave a stale hint");
});

test("Issue detail: a nested project path gets the hint and no schedule request; owner/name rows read their schedule (review F7)", async () => {
  assert.deepEqual(issueDatesView({ provider: "gitlab", repo: "acme/platform/web", number: 4 }), { schedulable: true, nestedHint: null });
  assert.deepEqual(issueDatesView({ provider: "github", repo: "acme/platform/web", number: 4 }), { schedulable: false, nestedHint: DETAIL_NESTED_HINT });
  assert.deepEqual(issueDatesView({ provider: "gitlab", repo: "acme/web", number: 4 }), { schedulable: true, nestedHint: null });
  assert.deepEqual(issueDatesView({ provider: "github", repo: "o/r", number: null }), { schedulable: false, nestedHint: null });
  let calls = 0;
  const req = async (_m: "GET", _p: string) => {
    calls += 1;
    return { status: 200, body: { schedules: [sched({ provider: "gitlab", repo: "acme/web", issueNumber: 4, startDate: "2026-01-05" })] } };
  };
  assert.deepEqual(await readIssueSchedule(req, { provider: "github", repo: "acme/platform/web", number: 4 }), { kind: "skipped" });
  assert.equal(calls, 0);
  const read = await readIssueSchedule(req, { provider: "gitlab", repo: "acme/web", number: 4 });
  assert.equal(read.kind === "ok" && read.schedule?.startDate, "2026-01-05");
  assert.deepEqual(await readIssueSchedule(async () => { throw new Error("x"); }, { provider: "github", repo: "o/r", number: 1 }), { kind: "error", error: "The core is not reachable right now." });
  const detail = readFileSync(new URL("../../issues/IssueDetail.tsx", import.meta.url), "utf8");
  assert.match(detail, /\{nestedHint \? <p className="iss-hint">\{nestedHint\}<\/p> : null\}/);
});

test("Gantt load pages the issues through the 20-page walk and reports the paging state (2,000 of 4,212)", async () => {
  const total = 4212;
  const calls: string[] = [];
  const core = async (_m: "GET", path: string) => {
    calls.push(path);
    if (path.startsWith("/kb/issue-schedule")) return { status: 200, body: { schedules: [] } };
    const u = new URL(path, "http://127.0.0.1");
    const offset = Number(u.searchParams.get("offset") ?? 0);
    const n = Math.max(0, Math.min(100, total - offset));
    const rows = Array.from({ length: n }, (_, k) => issue({ id: String(offset + k + 1), number: offset + k + 1 }));
    const hasMore = offset + n < total;
    return { status: 200, body: { issues: rows, total, hasMore, nextOffset: hasMore ? offset + n : null } };
  };
  const progress: string[] = [];
  const r = await loadTimeline(core, "github", "", { onProgress: (p) => progress.push(`${p.loaded}/${p.total}`) });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.issues.length, 2000);
  assert.equal(r.paging.stop, "cap");
  assert.equal(r.paging.total, total);
  assert.equal(calls.filter((c) => c.startsWith("/kb/issues")).length, 20);
  assert.equal(progress.length, 20);
  assert.equal(progress[0], "100/4212");
});

test("the Gantt keeps every loaded issue as a row (no 500-row cut): 2,000 issues make 2,000 rows", () => {
  const rows = buildRows(Array.from({ length: 2000 }, (_, k) => issue({ id: String(k), number: k + 1 })), [], "github", "");
  assert.equal(rows.length, 2000);
});

test("Gantt load: a later page answering 401 keeps the rows read so far and warns to sign in again", async () => {
  const core = async (_m: "GET", path: string) => {
    if (path.startsWith("/kb/issue-schedule")) return { status: 200, body: { schedules: [] } };
    const offset = Number(new URL(path, "http://127.0.0.1").searchParams.get("offset") ?? 0);
    if (offset > 0) return { status: 401, body: {} };
    const rows = Array.from({ length: 100 }, (_, k) => issue({ id: String(k + 1), number: k + 1 }));
    return { status: 200, body: { issues: rows, total: 300, hasMore: true, nextOffset: 100 } };
  };
  const r = await loadTimeline(core, "github", "");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.issues.length, 100);
  assert.equal(r.paging.stop, "error");
  assert.equal(r.warning, "Sign in again to read issues.");
});

test("Gantt load: a whole read has no warning, and the screen shows the warning and clears the note on failure", async () => {
  const core = async (_m: "GET", path: string) => path.startsWith("/kb/issue-schedule")
    ? { status: 200, body: { schedules: [] } }
    : { status: 200, body: { issues: [issue()], total: 1, hasMore: false, nextOffset: null } };
  const r = await loadTimeline(core, "github", "");
  assert.equal(r.ok && r.warning, null);
  const screen = readFileSync(new URL("../GanttScreen.tsx", import.meta.url), "utf8");
  assert.match(screen, /setError\(r\.warning\)/);
  assert.match(screen, /setError\(r\.error\);\s*\/\/[^\n]*\n\s*setPaging\(null\)/);
});

const ok = (body: unknown) => ({ status: 200, body });

// The core's key rules (kb/issue-schedule.mjs assertRepo), as a fake core answers them. The literal table lives in
// issues-model.test.ts; this copy is only what the round trip below needs.
function fakeCoreKeyOk(provider: string, repo: string): boolean {
  const segs = repo.split("/");
  const max = provider === "gitlab" ? 20 : 2;
  return repo.length <= 255 && segs.length >= 2 && segs.length <= max && (provider === "gitlab" || segs.length === 2)
    && segs.every((x) => /^[A-Za-z0-9._-]+$/.test(x) && x !== "." && x !== "..");
}

test("nested GitLab keys (3 and 4 parts) read and write through the overlay; the key keeps the repo's case, as the core stores it", async () => {
  const stored: { provider: string; repo: string; issueNumber: number; startDate: string | null; dueDate: string | null; estimateDays: number | null; dependsOn: number[] }[] = [];
  const core = async (method: "GET" | "PUT", path: string, body?: unknown) => {
    if (path.startsWith("/kb/issues")) return ok({ issues: [issue({ provider: "gitlab", repo: "Acme/Platform/Web", number: 4 })] });
    if (method === "GET") {
      const q = new URL(path, "http://core").searchParams;
      if (!fakeCoreKeyOk(q.get("provider")!, q.get("repo")!)) return { status: 400, body: null };
      return ok({ schedules: stored.filter((r) => r.provider === q.get("provider") && r.repo === q.get("repo")) });
    }
    const b = body as typeof stored[number];
    if (!fakeCoreKeyOk(b.provider, b.repo)) return { status: 400, body: null };
    stored.push(b);
    return ok({ schedule: b });
  };
  const draft = { start: "2026-01-05", due: "2026-01-07", estimate: "", depends: "" };
  const save = scheduleSaveBody(draft, { provider: "gitlab", repo: "Acme/Platform/Web", issueNumber: 4 });
  assert.equal(save.ok, true);
  assert.equal((await core("PUT", "/kb/issue-schedule", save.ok ? save.body : null)).status, 200);
  const load = await loadTimeline(core as never, "gitlab", "Acme/Platform/Web");
  assert.equal(load.ok && load.nestedHint, false);
  const rows = load.ok ? buildRows(load.issues, load.schedules, "gitlab", "Acme/Platform/Web") : [];
  assert.equal(rows[0]?.schedule?.startDate, "2026-01-05", "the issue key and the stored key match");
  // A 4-part path round-trips too; a lower-cased repo is a different key (no dates), so the case must be exact.
  const deep = await loadTimeline(core as never, "gitlab", "acme/platform/tools/web");
  assert.equal(deep.ok && deep.nestedHint, false);
  const lower = await loadTimeline(core as never, "gitlab", "Acme/Platform/Web".toLowerCase());
  assert.equal(lower.ok && lower.schedules.length, 0);
});

test("keys the core would 400 are never sent: GitHub nested, dot and odd segments, 21 segments, empty segment, over 255 chars", async () => {
  const bad: [string, string][] = [
    ["github", "acme/platform/web"], ["github", "acme/.."], ["gitlab", "acme/platform/../web"], ["gitlab", "acme/pla tform/web"],
    ["gitlab", "acme//web"], ["gitlab", "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u"], ["gitlab", `a/${"x".repeat(255)}`],
  ];
  for (const [provider, repo] of bad) {
    assert.equal(canSchedule({ provider, repo, number: 1 }), false, `${provider} ${repo}`);
    assert.equal(issueDatesView({ provider, repo, number: 1 }).nestedHint, DETAIL_NESTED_HINT, `${provider} ${repo}`);
    const calls: string[] = [];
    const load = await loadTimeline(async (_m: "GET", p: string) => {
      calls.push(p);
      return p.startsWith("/kb/issues") ? ok({ issues: [issue({ provider, repo, number: 1 })] }) : ok({ schedules: [] });
    }, provider, repo);
    assert.equal(load.ok && load.nestedHint, true, `${provider} ${repo}`);
    assert.equal(calls.some((c) => c.startsWith("/kb/issue-schedule")), false, `no overlay request for ${provider} ${repo}`);
  }
});

test("an older core (before API 106) answers 400 for a nested key: one request, the hint once, no error and no retry", async () => {
  let overlayCalls = 0;
  const old = async (_m: "GET", p: string) => {
    if (p.startsWith("/kb/issues")) return ok({ issues: [issue({ provider: "gitlab", repo: "acme/platform/web", number: 4 })] });
    overlayCalls += 1;
    return { status: 400, body: { error: { code: "VALIDATION_FAILED", message: "repo must be \"owner/name\"" } } };
  };
  const load = await loadTimeline(old, "gitlab", "acme/platform/web");
  assert.equal(load.ok, true);
  assert.equal(load.ok && load.nestedHint, true);
  assert.equal(load.ok && load.schedules.length, 0);
  assert.equal(load.ok && load.issues.length, 1, "the issues still list");
  assert.equal(overlayCalls, 1, "one overlay request, no retry");
  assert.equal(GANTT_NESTED_HINT.includes("20 path segments"), true);

  overlayCalls = 0;
  const detail = await readIssueSchedule(old, { provider: "gitlab", repo: "acme/platform/web", number: 4 });
  assert.deepEqual(detail, { kind: "unsupported" });
  assert.equal(overlayCalls, 1);
  const detailSrc = readFileSync(new URL("../../issues/IssueDetail.tsx", import.meta.url), "utf8");
  assert.match(detailSrc, /r\.kind === "unsupported"\) setRefused\(true\);/);

  // A 2-part repo is unchanged: a 400 there is still a load error, not the hint.
  const flat = await loadTimeline(async (_m: "GET", p: string) => (p.startsWith("/kb/issues") ? ok({ issues: [] }) : { status: 400, body: null }), "gitlab", "acme/web");
  assert.equal(flat.ok, false);
});


test("shiftSchedule moves both inclusive bar days and refuses zero/no-span shifts", () => {
  const schedule = sched({ startDate: "2026-01-05", dueDate: "2026-01-08" });
  const row = { ...span(schedule), schedule };
  assert.deepEqual(shiftSchedule(row, 1), { startDate: "2026-01-06", dueDate: "2026-01-09" });
  assert.deepEqual(shiftSchedule(row, -2), { startDate: "2026-01-03", dueDate: "2026-01-06" });
  assert.equal(shiftSchedule(row, 0), null);
  assert.equal(shiftSchedule({ ...row, start: null, schedule: null }, 1), null);
  assert.equal(shiftSchedule(row, 1.5), null);
  const sameDay = sched({ startDate: "2026-01-05", dueDate: "2026-01-05" });
  assert.deepEqual(shiftSchedule({ ...span(sameDay), schedule: sameDay }, 1), { startDate: "2026-01-06", dueDate: "2026-01-06" });
  const startOnly = sched({ startDate: "2026-01-05" });
  assert.deepEqual(shiftSchedule({ ...span(startOnly), schedule: startOnly }, 1), { startDate: "2026-01-06", dueDate: null });
  const dueOnly = sched({ dueDate: "2026-01-08" });
  assert.deepEqual(shiftSchedule({ ...span(dueOnly), schedule: dueOnly }, 1), { startDate: null, dueDate: "2026-01-09" });
});


test("shiftScheduleBody preserves estimate/dependencies and refuses numberless rows", () => {
  const row = {
    issue: issue({ number: 7, provider: "gitlab", repo: "acme/web" }),
    schedule: sched({ startDate: "2026-02-02", dueDate: "2026-02-05", estimateDays: 3, dependsOn: [2] }),
    ...span(sched({ startDate: "2026-02-02", dueDate: "2026-02-05" })), dependsOn: [2],
  };
  assert.deepEqual(shiftScheduleBody(row, 2), {
    provider: "gitlab", repo: "acme/web", issueNumber: 7,
    startDate: "2026-02-04", dueDate: "2026-02-07", estimateDays: 3, dependsOn: [2],
  });
  assert.equal(shiftScheduleBody({ ...row, issue: issue({ number: null }) }, 1), null);
  assert.equal(shiftScheduleBody(row, 0), null);
  assert.deepEqual(scheduleBody(row, 0), {
    provider: "gitlab", repo: "acme/web", issueNumber: 7,
    startDate: "2026-02-02", dueDate: "2026-02-05", estimateDays: 3, dependsOn: [2],
  });
});


test("dragShift uses a 3 px threshold and whole-day round steps", () => {
  assert.deepEqual(dragShift(100, 102, 20), { moved: false, days: 0 });
  assert.deepEqual(dragShift(100, 103, 20), { moved: true, days: 0 });
  assert.deepEqual(dragShift(100, 141, 20), { moved: true, days: 2 });
  assert.deepEqual(dragShift(100, 59, 20), { moved: true, days: -2 });
  assert.deepEqual(dragShift(100, 100, 0), { moved: false, days: 0 });
});


test("queued shifts accumulate for the same issue and stay separate for another", () => {
  const a = { issue: issue({ id: "a", number: 7 }), schedule: sched({ startDate: "2026-01-05" }), start: 0, end: 0 } as never;
  const b = { issue: issue({ id: "b", number: 8 }), schedule: sched({ startDate: "2026-01-05" }), start: 0, end: 0 } as never;
  const q = enqueueShift([], a, 1);
  enqueueShift(q, a, 2);
  enqueueShift(q, b, -1);
  assert.equal(q.length, 2);
  assert.equal(q[0]!.days, 3);
  assert.equal(q[1]!.days, -1);
});

test("a saved shift leaves the queue only while it is still the head and unchanged", () => {
  const row = { issue: issue({ id: "a", number: 7 }), schedule: sched({ startDate: "2026-01-05" }), start: 0, end: 0 } as never;
  const q = enqueueShift([], row, 1);
  const item = q[0]!;
  enqueueShift(q, row, 2);
  settleShift(q, item, 1);
  assert.equal(q.length, 1, "more days accumulated during the save: the item stays for the next save");
  const cleared: typeof q = [];
  settleShift(cleared, item, 1);
  assert.equal(cleared.length, 0, "a queue cleared for another view is not shifted");
  const replaced = enqueueShift([], row, 5)[0]!;
  settleShift([replaced], item, 1);
  assert.equal(replaced.days, 5, "an item that replaced the saved one is never dropped");
});

test("presetRange: today, two weeks, month and quarter", () => {
  const today = Math.floor(Date.UTC(2026, 10, 15) / 86_400_000);
  assert.deepEqual(presetRange("today", today), { from: "2026-11-15", until: "2026-11-15" });
  assert.deepEqual(presetRange("2w", today), { from: "2026-11-08", until: "2026-11-22" });
  assert.deepEqual(presetRange("month", today), { from: "2026-11-01", until: "2026-11-30" });
  assert.deepEqual(presetRange("quarter", today), { from: "2026-10-01", until: "2026-12-31" });
  assert.deepEqual(presetRange("all", today), { from: "", until: "" });
});

// --- one view over GitHub and GitLab: GitLab's own due date, any-provider rows, a joined multi-provider load ---

test("a GitLab issue with its own due date is drawn from it; the overlay's dates still win", async () => {
  const { effectiveSchedule } = await import("../gantt-model.ts");
  const gl = issue({ provider: "gitlab", repo: "g/p", number: 5, dueDate: "2026-01-07" });
  assert.deepEqual(buildRows([gl] as never, [], "gitlab", "")[0]!.start, span(sched({ dueDate: "2026-01-07" })).start, "no overlay: the provider's due date");
  const own = sched({ provider: "gitlab", repo: "g/p", issueNumber: 5, startDate: "2026-01-05", dueDate: "2026-01-06" });
  assert.deepEqual(effectiveSchedule(own, gl as never), own, "overlay dates win");
  const est = sched({ provider: "gitlab", repo: "g/p", issueNumber: 5, estimateDays: 2 });
  assert.deepEqual(span(effectiveSchedule(est, gl as never)), { start: 20458, end: 20459 }, "an overlay estimate shapes the provider's due date");
  assert.equal(effectiveSchedule(null, issue({ provider: "github" }) as never), null, "GitHub has no date of its own");
  assert.equal(buildRows([issue({ provider: "gitlab", dueDate: null })] as never, [], "gitlab", "")[0]!.start, null);
});

test("buildRows with no provider shows every provider's rows, and a repo still narrows them", () => {
  const rows = [issue({ number: 1 }), issue({ number: 2, provider: "gitlab", repo: "g/p" })] as never;
  assert.equal(buildRows(rows, [], "", "").length, 2);
  assert.deepEqual(buildRows(rows, [], "", "g/p").map((r) => r.issue.number), [2]);
  assert.deepEqual(buildRows(rows, [], "github", "").map((r) => r.issue.number), [1]);
});

test("loadScopeTimeline joins the providers; one failing provider is a warning, all failing is an error", async () => {
  const { loadScopeTimeline } = await import("../gantt-model.ts");
  const row = (provider: string) => ({ id: provider, title: provider, provider, repo: "x/y", number: 1, state: "open", labels: [] });
  const make = (fail: string[]) => async (_m: "GET", path: string) => {
    const u = new URL(path, "http://x");
    const provider = u.searchParams.get("provider") ?? "";
    if (fail.includes(provider)) return { status: 500, body: {} };
    return u.pathname === "/kb/issues" ? { status: 200, body: { issues: [row(provider)], total: 1, hasMore: false, nextOffset: null } } : { status: 200, body: { schedules: [] } };
  };
  const both = await loadScopeTimeline(make([]), { providers: ["github", "gitlab"], repo: "" });
  assert.ok(both.ok && both.issues.length === 2 && both.paging.total === 2);
  const one = await loadScopeTimeline(make(["gitlab"]), { providers: ["github", "gitlab"], repo: "" });
  assert.ok(one.ok && one.issues.length === 1 && one.warning !== null, "github rows survive a gitlab failure");
  const none = await loadScopeTimeline(make(["github", "gitlab"]), { providers: ["github", "gitlab"], repo: "" });
  assert.equal(none.ok, false);
});
