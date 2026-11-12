// Gantt data: the scheduling overlay (`GET /kb/issue-schedule`) merged with the cached issues, and the pure date
// math the timeline needs. GitHub issues have no dates; the overlay supplies start/due/estimate/dependency, and
// this model decides each bar's span exactly as the Mac's GanttViewModel does (dates win, estimate fills a missing
// end or start). Undated issues are kept in a separate list, never given a made-up span.
import { MAX_LOADED, overlayRepoSupported, type Issue } from "../issues/issues-model.ts";
import { issuesLoadError, loadIssuePages, mergePaging, type PagingProgress, type PagingResult } from "../issues/issue-paging.ts";


/** GitHub titles imported by the local importer may already start with "#<number>"; don't render it twice. */
export function issueTitleBody(issue: Pick<Issue, "number" | "title">): string {
  if (issue.number === null) return issue.title;
  const match = new RegExp(`^#\\s*${issue.number}\\b[\\s:.-]*`).exec(issue.title.trim());
  return match ? issue.title.trim().slice(match[0].length) || issue.title.trim() : issue.title;
}
export function issueLabel(issue: Pick<Issue, "number" | "title">): string {
  const body = issueTitleBody(issue);
  return issue.number === null ? body : `#${issue.number} ${body}`.trim();
}

export interface Schedule {
  provider: string;
  repo: string;
  issueNumber: number;
  startDate: string | null;
  dueDate: string | null;
  estimateDays: number | null;
  dependsOn: number[];
  updatedAt?: string | null;
}

export interface GanttRow {
  issue: Issue;
  schedule: Schedule | null;
  /** Inclusive day numbers (days since 1970-01-01 UTC), or null when the issue has no schedulable dates. */
  start: number | null;
  end: number | null;
  dependsOn: number[];
}

const DAY_MS = 86_400_000;
/** The most rows a walk can load (2,000): the Gantt draws every one, so the row cap is the load cap. */
const MAX_ROWS = MAX_LOADED;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** Days since the epoch for a `YYYY-MM-DD` date; null for a malformed date. */
export function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC normalises 2026-13-01 into 2027-01-01; a malformed date must not become a real day.
  if (!Number.isFinite(dt.getTime()) || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.floor(dt.getTime() / DAY_MS);
}

/**
 * Today's day number on the user's local calendar, as the Mac's `Calendar.current` sees it. Schedule dates are
 * local calendar days, so `Date.now() / DAY_MS` (a UTC day) is a day early for the first hours of a UTC+ day
 * (00:00–08:59 in Japan): the today line sat on yesterday and an issue due yesterday was not yet overdue.
 */
export function localToday(now: Date = new Date()): number {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS);
}

/** `YYYY-MM-DD` for a day number. */
export function dayString(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Parse `{ schedules: [...] }`; unknown rows and bad values are dropped (null dates stay null). */
export function decodeSchedules(body: unknown): Schedule[] {
  const list = isRecord(body) && Array.isArray(body.schedules) ? body.schedules : [];
  const out: Schedule[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const provider = typeof row.provider === "string" ? row.provider : "github";
    const repo = typeof row.repo === "string" ? row.repo : "";
    const n = typeof row.issueNumber === "number" && Number.isInteger(row.issueNumber) && row.issueNumber > 0 ? row.issueNumber : null;
    if (!repo || n === null) continue;
    const dependsOn = Array.isArray(row.dependsOn)
      ? [...new Set(row.dependsOn.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x > 0))].slice(0, 50)
      : [];
    out.push({ provider, repo, issueNumber: n, startDate: str(row.startDate), dueDate: str(row.dueDate), estimateDays: num(row.estimateDays), dependsOn, updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null });
    if (out.length >= MAX_LOADED) break;
  }
  return out;
}

/**
 * Whether an issue can carry a schedule overlay: the core's `/kb/issue-schedule` takes both providers
 * (kb/issue-schedule.mjs ALLOWED_PROVIDERS), keyed by owner/name and the issue number.
 */
export function canSchedule(issue: Pick<Issue, "provider" | "repo" | "number">): boolean {
  return (issue.provider === "github" || issue.provider === "gitlab") && issue.number !== null && overlayRepoSupported(issue.repo, issue.provider);
}

/**
 * The note shown wherever a GitLab row's dates are shown or edited (the schedule editor, the issue's Dates section).
 * The Mac never uses this overlay for GitLab (GitLabClient+RepoBackend.swift usesScheduleOverlay = false) and edits
 * GitLab's own due date instead (RepoIssueDetailSheet.swift); the desktop keeps its dates in the local overlay,
 * so it says plainly that they stay on this computer. Null for GitHub, whose overlay dates are the Mac's too.
 */
export const GITLAB_LOCAL_DATES_NOTE = "Saved on this computer only. It is not sent to GitLab.";
export function localDatesNote(issue: Pick<Issue, "provider">): string | null {
  return issue.provider === "gitlab" ? GITLAB_LOCAL_DATES_NOTE : null;
}

/** The schedule key for an issue. */
export function scheduleKey(provider: string, repo: string, number: number): string {
  return `${provider}\u0000${repo}\u0000${number}`;
}

/**
 * The schedule a bar is drawn from. The overlay's own dates win; an issue the overlay has no dates for falls back to the
 * provider's own due date (GitLab issues carry one), so the Issues board and the Gantt show the same day. The estimate
 * and dependencies still come from the overlay.
 */
export function effectiveSchedule(schedule: Schedule | null, issue: Pick<Issue, "provider" | "repo" | "number" | "dueDate">): Schedule | null {
  if (!issue.dueDate || (schedule && (schedule.startDate || schedule.dueDate))) return schedule;
  return {
    provider: issue.provider, repo: issue.repo, issueNumber: issue.number ?? 0,
    startDate: null, dueDate: issue.dueDate, estimateDays: schedule?.estimateDays ?? null, dependsOn: schedule?.dependsOn ?? [],
  };
}

/** Merge issues with schedules for one provider (`""` = any) and optional repo. Pull requests are not rows. */
export function buildRows(issues: readonly Issue[], schedules: readonly Schedule[], provider: string, repo: string): GanttRow[] {
  const byKey = new Map<string, Schedule>();
  for (const s of schedules) byKey.set(scheduleKey(s.provider, s.repo, s.issueNumber), s);
  const out: GanttRow[] = [];
  for (const issue of issues) {
    if (issue.isPR || (provider && issue.provider !== provider)) continue;
    if (repo && issue.repo !== repo) continue;
    if (issue.number === null) continue;
    const schedule = byKey.get(scheduleKey(issue.provider, issue.repo, issue.number)) ?? null;
    const { start, end } = span(effectiveSchedule(schedule, issue));
    out.push({ issue, schedule, start, end, dependsOn: schedule?.dependsOn ?? [] });
    if (out.length >= MAX_ROWS) break;
  }
  return out.sort((a, b) => {
    if (a.start === null && b.start !== null) return 1;
    if (b.start === null && a.start !== null) return -1;
    if (a.start !== null && b.start !== null && a.start !== b.start) return a.start - b.start;
    return (a.issue.number ?? 0) - (b.issue.number ?? 0);
  });
}

/** The Mac's GanttViewModel.defaultSpanDays: a single known date without an estimate spans this many days. */
export const DEFAULT_SPAN_DAYS = 7;

/**
 * Whole days the Mac draws for an estimate. The Mac measures calendar days between startOfDay of its two instants:
 * a start-anchored bar ends at startOfDay(start + est), which truncates (2.5 -> 2); a due-anchored bar starts at
 * startOfDay(due - est), which rounds up (2.5 -> 3). Never less than one day.
 */
export function estimateSpanDays(est: number, anchor: "start" | "due"): number {
  return Math.max(1, anchor === "start" ? Math.floor(est) : Math.ceil(est));
}

export interface QueuedShift { key: string; row: GanttRow; days: number }
export const shiftKey = (row: GanttRow): string => `${row.issue.provider}:${row.issue.repo}#${row.issue.number ?? row.issue.id}`;
/** Queue a shift; a second shift of the same issue while a save is in flight accumulates on the original row. */
export function enqueueShift(queue: QueuedShift[], row: GanttRow, days: number): QueuedShift[] {
  const key = shiftKey(row);
  const found = queue.find((q) => q.key === key);
  if (found) found.days += days;
  else queue.push({ key, row, days });
  return queue;
}

/**
 * Drop a saved shift from the queue, but only when it is still the head AND no further shift accumulated on it while
 * the save ran. A queue that was cleared (the provider or repo changed mid-save) or re-filled must not lose the item
 * that replaced it.
 */
export function settleShift(queue: QueuedShift[], item: QueuedShift, savedDays: number): void {
  if (queue[0] === item && item.days === savedDays) queue.shift();
}

/** A pointer drag's day delta: a 3 px threshold stops a click from becoming a tiny move. */
export function dragShift(startX: number, clientX: number, dayWidth: number): { moved: boolean; days: number } {
  const delta = clientX - startX;
  return { moved: Math.abs(delta) >= 3, days: Math.round(delta / Math.max(1, dayWidth)) };
}

/** Target dates for a whole-day shift, allowing 0 (a queued compensating gesture must re-send the original dates). */
function shiftedDates(row: Pick<GanttRow, "schedule" | "start" | "end">, days: number): { startDate: string | null; dueDate: string | null } | null {
  if (!Number.isInteger(days)) return null;
  const start = row.schedule?.startDate ? dayNumber(row.schedule.startDate) : null;
  const due = row.schedule?.dueDate ? dayNumber(row.schedule.dueDate) : null;
  if (start !== null || due !== null) {
    return { startDate: start === null ? null : dayString(start + days), dueDate: due === null ? null : dayString(due + days) };
  }
  if (row.start === null || row.end === null) return null;
  return { startDate: dayString(row.start + days), dueDate: dayString(row.end + days + 1) };
}

/** Shift a row's actual schedule dates by whole days, preserving a missing side; fall back to the drawn bar for an
 *  estimate-only row (where moving the bar must materialise dates). Null for a zero/no-span shift. */
export function shiftSchedule(row: Pick<GanttRow, "schedule" | "start" | "end">, days: number): { startDate: string | null; dueDate: string | null } | null {
  return days === 0 ? null : shiftedDates(row, days);
}

/** The PUT body for a queued target, including 0. Null only when the row has no span/number. */
export function scheduleBody(row: GanttRow, days: number): (ScheduleKey & { startDate: string | null; dueDate: string | null; estimateDays: number | null; dependsOn: number[] }) | null {
  const shifted = shiftedDates(row, days);
  if (shifted === null || row.issue.number === null) return null;
  return {
    provider: row.issue.provider, repo: row.issue.repo, issueNumber: row.issue.number,
    ...shifted, estimateDays: row.schedule?.estimateDays ?? null, dependsOn: row.dependsOn,
  };
}

/** The PUT body for a drag/keyboard shift; null when the row cannot be scheduled or the shift is zero. */
export function shiftScheduleBody(row: GanttRow, days: number): ReturnType<typeof scheduleBody> {
  return days === 0 ? null : scheduleBody(row, days);
}

/**
 * A bar's drawn days, as inclusive day numbers, by the Mac's exact rule (GanttView.swift barGeometry): the bar
 * starts on startOfDay(startDate) and is max(1, days from startOfDay(startDate) to startOfDay(endDate)) long, so
 * its end day is NOT drawn. Explicit Jan 5 to Jan 7 covers Jan 5 and Jan 6; a due-only bar with the 7-day default
 * covers due - 7 to due - 1; a start-only bar covers start to start + estimate - 1. startDate/endDate are the
 * GanttViewModel's (GanttViewModel.swift startDate/endDate): dates win, an estimate (or the 7-day default) fills
 * the missing side. Reversed explicit dates draw a one-day bar at the start date (the editor refuses to save them).
 */
export function span(s: Schedule | null): { start: number | null; end: number | null } {
  if (!s) return { start: null, end: null };
  const start = s.startDate ? dayNumber(s.startDate) : null;
  const due = s.dueDate ? dayNumber(s.dueDate) : null;
  const hasEst = s.estimateDays !== null && s.estimateDays >= 0;
  const drawn = (from: number, len: number) => ({ start: from, end: from + Math.max(1, len) - 1 });
  if (start !== null && due !== null) return drawn(start, due - start);
  // startOfDay(start + est) - start truncates the estimate.
  if (start !== null) return drawn(start, hasEst ? Math.floor(s.estimateDays!) : DEFAULT_SPAN_DAYS);
  if (due !== null) {
    // startOfDay(due - est) rounds the estimate up; a stored 0 starts (and draws one day) on the due day itself.
    const len = hasEst ? Math.ceil(s.estimateDays!) : DEFAULT_SPAN_DAYS;
    return drawn(due - len, len);
  }
  return { start: null, end: null };
}

export interface TimelineRange {
  start: number;
  days: number;
}

/** The visible range: every dated bar, padded, at least three weeks; today-centred when nothing is dated. */
export function timelineRange(rows: readonly GanttRow[], today = localToday()): TimelineRange {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    if (r.start === null || r.end === null) continue;
    min = Math.min(min, r.start);
    max = Math.max(max, r.end);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { start: today - 14, days: 45 }; // the Mac's empty range: 14 days back, 30 ahead
  const start = Math.min(min, today) - 3;
  const end = Math.max(max, today) + 3;
  return { start, days: Math.max(21, end - start + 1) };
}

/** True for Saturday/Sunday (UTC day numbers; the chart's tint only). */
export function isWeekend(day: number): boolean {
  const dow = new Date(day * DAY_MS).getUTCDay();
  return dow === 0 || dow === 6;
}

/** Left/width in px for a bar, clamped to the range. Null when the row is undated. */
export function barGeometry(row: GanttRow, range: TimelineRange, dayWidth: number): { left: number; width: number; clippedStart: boolean; clippedEnd: boolean } | null {
  if (row.start === null || row.end === null) return null;
  const left = (Math.max(row.start, range.start) - range.start) * dayWidth;
  const right = (Math.min(row.end, range.start + range.days - 1) - range.start + 1) * dayWidth;
  if (right <= 0 || left >= range.days * dayWidth) return null;
  return { left, width: Math.max(dayWidth, right - left), clippedStart: row.start < range.start, clippedEnd: row.end > range.start + range.days - 1 };
}

/** Rows drawn above and below the viewport, so a short scroll never shows an empty band. */
export const GANTT_WINDOW_BUFFER = 6;

/**
 * The rendered row range [first, last] (inclusive) for a scrolled timeline: the rows under the viewport (the head
 * sits over the first `headHeight` px) plus `buffer` rows either side, clamped to the list. A `pinned` row (the focused
 * one) outside that range comes back as `extra`, drawn on its own (not by stretching the range: a row focused at the
 * top and then scrolled 1,500 rows away must not mount the 1,500 rows between). count 0 gives an empty range.
 */
export function visibleRowWindow(s: { scrollTop: number; viewportHeight: number; headHeight: number; rowHeight: number; count: number; pinned?: number | null; buffer?: number }): { first: number; last: number; extra: number | null } {
  if (s.count <= 0) return { first: 0, last: -1, extra: null };
  const buffer = s.buffer ?? GANTT_WINDOW_BUFFER;
  const clamp = (n: number) => Math.min(s.count - 1, Math.max(0, n));
  const first = clamp(Math.floor((s.scrollTop - s.headHeight) / s.rowHeight) - buffer);
  const last = clamp(Math.ceil((s.scrollTop + s.viewportHeight - s.headHeight) / s.rowHeight) + buffer);
  const p = s.pinned;
  const extra = p !== undefined && p !== null && Number.isInteger(p) && p >= 0 && p < s.count && (p < first || p > last) ? p : null;
  return { first, last, extra };
}

export function datedRows(rows: readonly GanttRow[]): GanttRow[] {
  return rows.filter((r) => r.start !== null && r.end !== null);
}

export function undatedRows(rows: readonly GanttRow[]): GanttRow[] {
  return rows.filter((r) => r.start === null || r.end === null);
}

/** The Mac's legend categories: closed wins, then overdue (end before today), else open. */
export type GanttCategory = "open" | "closed" | "overdue";
export const GANTT_CATEGORIES: readonly GanttCategory[] = ["open", "closed", "overdue"];

/**
 * The Mac's GanttViewModel startDate/endDate for a row, in (possibly fractional) day numbers. The drawn span is
 * inclusive (a 7-day bar from day s ends on s + 6), but the Mac's endDate for a start-only schedule is start +
 * estimate (default 7) and its startDate for a due-only one is due − estimate: overdue and the date-range filter
 * compare those, so a start-only bar turns overdue the day after the Mac's end, not a day early.
 */
export function macBounds(row: Pick<GanttRow, "start" | "end"> & { schedule?: Schedule | null }): { start: number | null; end: number | null } {
  const s = row.schedule;
  if (s) {
    const start = s.startDate ? dayNumber(s.startDate) : null;
    const due = s.dueDate ? dayNumber(s.dueDate) : null;
    const est = s.estimateDays !== null && s.estimateDays >= 0 ? s.estimateDays : DEFAULT_SPAN_DAYS;
    // Both dates: the Mac's endDate is the due date even when it precedes the start (the bar is drawn at the start).
    if (start !== null && due !== null) return { start, end: due };
    if (start !== null && due === null) return { start, end: start + est };
    if (due !== null && start === null) return { start: due - est, end: due };
  }
  return { start: row.start, end: row.end };
}

/**
 * The bar tooltip's dates: the Mac's startDate and endDate days (the schedule's own dates when set), not the drawn
 * days, since the drawn bar stops the day before its end date.
 */
export function barDates(row: Pick<GanttRow, "start" | "end"> & { schedule?: Schedule | null }): string {
  const b = macBounds(row);
  const fmt = (d: number | null) => (d === null ? "" : dayString(Math.floor(d)));
  return `${fmt(b.start)} → ${fmt(b.end)}`;
}

export function rowCategory(row: Pick<GanttRow, "issue" | "end"> & { start?: number | null; schedule?: Schedule | null }, today: number): GanttCategory {
  if (row.issue.state === "closed") return "closed";
  const end = macBounds({ start: row.start ?? null, end: row.end, schedule: row.schedule }).end;
  // The due DAY is inclusive (Mac): an issue due today is not overdue until tomorrow.
  if (end !== null && end < today) return "overdue";
  return "open";
}

/** Legend counts over rows, for the chips. */
export function countCategories(rows: readonly GanttRow[], today: number): Record<GanttCategory, number> {
  const out: Record<GanttCategory, number> = { open: 0, closed: 0, overdue: 0 };
  for (const r of rows) out[rowCategory(r, today)] += 1;
  return out;
}

export interface GanttRowFilter {
  label: string;
  categories: readonly GanttCategory[];
  /** Inclusive day-number range bounds; null means open-ended. */
  from: number | null;
  until: number | null;
  today: number;
}

/**
 * The Mac's date-range and legend filters over rows. An undated issue is placed by its creation day, as the
 * Mac's startDate fallback does; with no date at all it is kept, since there is nothing to compare.
 */
export function filterRows(rows: readonly GanttRow[], f: GanttRowFilter): GanttRow[] {
  return rows.filter((r) => {
    if (f.label && !r.issue.labels.includes(f.label)) return false;
    if (!f.categories.includes(rowCategory(r, f.today))) return false;
    const created = r.issue.createdAt ? dayNumber(r.issue.createdAt.slice(0, 10)) : null;
    const b = macBounds(r);
    const s = b.start ?? created;
    const e = b.end ?? s;
    if (s === null || e === null) return true;
    if (f.from !== null && e < f.from) return false;
    if (f.until !== null && s > f.until) return false;
    return true;
  });
}

export interface DependencyLine {
  blocker: number;
  dependent: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Finish-to-start arrows between visible dated rows: from the blocker bar's end to the dependent bar's start.
 * `rowY` gives each row's vertical centre. A dependency on a row that is not visible, or on an undated row, has
 * no geometry and is skipped (the Mac does the same).
 */
export function dependencyLines(rows: readonly GanttRow[], range: TimelineRange, dayWidth: number, rowY: (index: number) => number): DependencyLine[] {
  const indexByNumber = new Map<number, number>();
  rows.forEach((r, i) => {
    if (r.issue.number !== null && !indexByNumber.has(r.issue.number)) indexByNumber.set(r.issue.number, i);
  });
  const out: DependencyLine[] = [];
  rows.forEach((dep, j) => {
    const dg = barGeometry(dep, range, dayWidth);
    if (!dg || dep.issue.number === null) return;
    for (const b of dep.dependsOn) {
      const i = indexByNumber.get(b);
      if (i === undefined) continue;
      const bg = barGeometry(rows[i]!, range, dayWidth);
      if (!bg) continue;
      out.push({ blocker: b, dependent: dep.issue.number, x1: bg.left + bg.width, y1: rowY(i), x2: dg.left, y2: rowY(j) });
    }
  });
  return out;
}

/**
 * The Gantt's project picker options: the saved repositories of the provider plus any repository the cached issues
 * name, de-duplicated and sorted, narrowed by the search text. The current choice always stays in the list so the
 * select can show it.
 */
export function projectOptions(saved: readonly string[], cached: readonly string[], query: string, current: string): string[] {
  const all = [...new Set([...saved, ...cached].filter((r) => r.trim() !== ""))].sort((a, b) => a.localeCompare(b, "en"));
  const q = query.trim().toLowerCase();
  return all.filter((r) => r === current || !q || r.toLowerCase().includes(q));
}

/** The Mac draws at least a viewport of days (GanttView displayDays), so the grid never stops short of the right edge. */
export function fillRange(range: TimelineRange, viewportWidth: number, dayWidth: number): TimelineRange {
  const days = Math.max(range.days, Math.ceil(viewportWidth / dayWidth));
  return days === range.days ? range : { start: range.start, days };
}

/** The scrollLeft that puts today about a third in from the left of the viewport. */
export function todayScrollLeft(todayLeft: number, viewportWidth: number): number {
  return Math.max(0, todayLeft - viewportWidth / 3);
}

/** Cmd/Ctrl+Enter saves the schedule editor, as the Mac's sheet does. */
export function isSaveShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

/** The Mac IssueScheduleEditorSheet stepper's upper bound. */
export const MAX_ESTIMATE_DAYS = 365;

export interface ScheduleDraft {
  start: string;
  due: string;
  estimate: string;
  depends: string;
}

export interface ScheduleKey {
  provider: string;
  repo: string;
  issueNumber: number;
}

export type ScheduleSave =
  | { ok: true; body: ScheduleKey & { startDate: string | null; dueDate: string | null; estimateDays: number | null; dependsOn: number[] } }
  | { ok: false; error: string };

/**
 * The schedule editor's save rules, as the Mac's IssueScheduleEditorSheet applies them: dates are YYYY-MM-DD or
 * empty, due cannot be before start, dependencies are issue numbers, and the estimate is a non-negative number.
 */
export function scheduleSaveBody(draft: ScheduleDraft, key: ScheduleKey): ScheduleSave {
  const bits = draft.depends.split(",").map((x) => x.trim()).filter(Boolean);
  const dependsOn: number[] = [];
  for (const b of bits) {
    const n = Number(b.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) return { ok: false, error: "Dependencies must be issue numbers, separated by commas." };
    if (!dependsOn.includes(n)) dependsOn.push(n);
  }
  if ((draft.start && dayNumber(draft.start) === null) || (draft.due && dayNumber(draft.due) === null)) {
    return { ok: false, error: "Dates are YYYY-MM-DD or empty." };
  }
  if (draft.start && draft.due && dayNumber(draft.due)! < dayNumber(draft.start)!) {
    return { ok: false, error: "Due date must be on or after the start date." };
  }
  const est = draft.estimate.trim() === "" ? null : Number(draft.estimate);
  // The Mac's stepper is 0..365 days and saves 0 as "no estimate" (nil), which keeps the 7-day default bar.
  if (est !== null && (!Number.isFinite(est) || est < 0 || est > MAX_ESTIMATE_DAYS)) {
    return { ok: false, error: `Estimate must be between 0 and ${MAX_ESTIMATE_DAYS} days.` };
  }
  return { ok: true, body: { ...key, startDate: draft.start || null, dueDate: draft.due || null, estimateDays: est ? est : null, dependsOn } };
}

/**
 * What a click does (Mac GanttView): tapping a row opens the issue's details; the schedule editor is the Mac's
 * "Edit Schedule…" (context menu / the detail's Dates Edit), reached here from the bar and from the details.
 */
export const GANTT_ROW_ACTIONS = { label: "details", bar: "schedule" } as const;

type Request = (method: "GET", path: string) => Promise<{ status: number; body: unknown }>;

/** The hint shown when the chosen project is a nested GitLab path the overlay cannot key. */
export const GANTT_NESTED_HINT = "Dates are kept only for projects the core can key (owner/name on GitHub, up to 20 path segments on GitLab); this project has none.";
export const DETAIL_NESTED_HINT = "Dates are kept only for projects the core can key (owner/name on GitHub, up to 20 path segments on GitLab); this one cannot store them.";

/** More than owner/name: a GitLab nested group path. An older core (before API 106) answers 400 for these keys. */
export function isNestedPath(repo: string): boolean {
  return repo.split("/").length > 2;
}

export type TimelineLoad =
  /** `warning`: a later page failed but the rows read so far are kept (issuesLoadError: a 401 asks to sign in again). */
  | { ok: true; issues: Issue[]; paging: PagingResult; schedules: Schedule[]; nestedHint: boolean; warning: string | null }
  | { ok: false; error: string; nestedHint: false };

/**
 * One Gantt load: the cached issues (paged, see loadIssuePages) plus the overlay, both started together. A
 * nested-group project is never sent to the overlay (the core answers 400); its schedule reads as empty and
 * `nestedHint` says why. A failed load never carries the hint, so a network error or a retry cannot leave a stale one.
 */
export async function loadTimeline(
  request: Request,
  provider: string,
  repo: string,
  opts: { signal?: AbortSignal; onProgress?: (p: PagingProgress) => void } = {},
): Promise<TimelineLoad> {
  const overlayOk = repo === "" || overlayRepoSupported(repo, provider);
  // Both requests start now, the issues first; a failed overlay read is caught below, not left unhandled.
  const pagingP = loadIssuePages(request, { provider, state: "all" }, opts);
  const scheduleP = (overlayOk
    ? request("GET", `/kb/issue-schedule?${new URLSearchParams({ provider, repo }).toString()}`)
    : Promise.resolve({ status: 200, body: { schedules: [] } as unknown })).then((r) => r, () => null);
  const paging = await pagingP;
  if (paging.stop === "error" && paging.issues.length === 0) {
    return { ok: false, nestedHint: false, error: paging.status === 401 ? "Sign in again to read the timeline." : paging.status === null ? "The core is not reachable right now." : "The core could not load the issues or their schedule." };
  }
  const s = await scheduleP;
  if (!s) return { ok: false, nestedHint: false, error: "The core is not reachable right now." };
  // A nested key an older core rejects: no dates, the hint once, no error (the request is not retried).
  if (s.status === 400 && overlayOk && isNestedPath(repo)) {
    return { ok: true, issues: paging.issues, paging, schedules: [], nestedHint: true, warning: issuesLoadError(paging) };
  }
  if (s.status !== 200) {
    return { ok: false, nestedHint: false, error: s.status === 401 ? "Sign in again to read the timeline." : "The core could not load the issues or their schedule." };
  }
  return { ok: true, issues: paging.issues, paging, schedules: decodeSchedules(s.body), nestedHint: !overlayOk, warning: issuesLoadError(paging) };
}

/**
 * The timeline for a view of one repository, or of every saved repository: one `loadTimeline` per provider in view
 * (a single repository reads just its own, with its path), joined. A provider that fails is reported only when
 * nothing else loaded, so one broken token does not blank the other provider's bars.
 */
export async function loadScopeTimeline(
  request: Request,
  scope: { providers: readonly string[]; repo: string },
  opts: { signal?: AbortSignal; onProgress?: (p: PagingProgress) => void } = {},
): Promise<TimelineLoad> {
  const all = await Promise.all(scope.providers.map((p) => loadTimeline(request, p, scope.repo, opts)));
  const ok = all.filter((r): r is Extract<TimelineLoad, { ok: true }> => r.ok);
  if (ok.length === 0) return all.find((r) => !r.ok) ?? { ok: false, error: "The core could not load the issues or their schedule.", nestedHint: false };
  if (all.length === 1) return all[0]!;
  const failed = all.find((r): r is Extract<TimelineLoad, { ok: false }> => !r.ok);
  return {
    ok: true,
    issues: ok.flatMap((r) => r.issues),
    paging: mergePaging(ok.map((r) => r.paging)),
    schedules: ok.flatMap((r) => r.schedules),
    nestedHint: ok.some((r) => r.nestedHint),
    warning: failed?.error ?? ok.find((r) => r.warning)?.warning ?? null,
  };
}

/**
 * The issue detail's Dates section: shown (and read) only for an overlay-keyable row; a numbered row on a nested
 * project path gets the hint instead and never sends a schedule request.
 */
export function issueDatesView(issue: Pick<Issue, "provider" | "repo" | "number">): { schedulable: boolean; nestedHint: string | null } {
  return { schedulable: canSchedule(issue), nestedHint: issue.number !== null && !overlayRepoSupported(issue.repo, issue.provider) ? DETAIL_NESTED_HINT : null };
}

/** `unsupported`: an older core answered 400 for a nested key, so the detail shows the hint and no dates. */
export type IssueScheduleRead = { kind: "skipped" } | { kind: "unsupported" } | { kind: "ok"; schedule: Schedule | null } | { kind: "error"; error: string };

/** The detail's schedule read; a row that cannot be scheduled (nested path, no number) is skipped without a request. */
export async function readIssueSchedule(request: Request, issue: Pick<Issue, "provider" | "repo" | "number">): Promise<IssueScheduleRead> {
  if (!canSchedule(issue)) return { kind: "skipped" };
  try {
    const r = await request("GET", `/kb/issue-schedule?${new URLSearchParams({ provider: issue.provider, repo: issue.repo }).toString()}`);
    if (r.status === 400 && isNestedPath(issue.repo)) return { kind: "unsupported" };
    if (r.status !== 200) return { kind: "error", error: `The schedule could not be read (${r.status}).` };
    return { kind: "ok", schedule: decodeSchedules(r.body).find((s) => s.provider === issue.provider && s.repo === issue.repo && s.issueNumber === issue.number) ?? null };
  } catch {
    return { kind: "error", error: "The core is not reachable right now." };
  }
}

export type GanttRangePreset = "all" | "today" | "2w" | "month" | "quarter" | "custom";

/** The from/until dates a range preset selects (empty strings = no bound). */
export function presetRange(preset: GanttRangePreset, today: number): { from: string; until: string } {
  if (preset === "all" || preset === "custom") return { from: "", until: "" };
  const date = new Date(today * DAY_MS);
  if (preset === "today") return { from: dayString(today), until: dayString(today) };
  if (preset === "2w") return { from: dayString(today - 7), until: dayString(today + 7) };
  const y = date.getUTCFullYear();
  if (preset === "month") {
    return { from: dayString(Math.floor(Date.UTC(y, date.getUTCMonth(), 1) / DAY_MS)), until: dayString(Math.floor(Date.UTC(y, date.getUTCMonth() + 1, 0) / DAY_MS)) };
  }
  const q = Math.floor(date.getUTCMonth() / 3) * 3;
  return { from: dayString(Math.floor(Date.UTC(y, q, 1) / DAY_MS)), until: dayString(Math.floor(Date.UTC(y, q + 3, 0) / DAY_MS)) };
}
