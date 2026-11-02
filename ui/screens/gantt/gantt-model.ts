// Gantt data: the scheduling overlay (`GET /kb/issue-schedule`) merged with the cached issues, and the pure date
// math the timeline needs. GitHub issues have no dates; the overlay supplies start/due/estimate/dependency, and
// this model decides each bar's span exactly as the Mac's GanttViewModel does (dates win, estimate fills a missing
// end or start). Undated issues are kept in a separate list, never given a made-up span.
import type { Issue } from "../issues/issues-model.ts";


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
const MAX_ROWS = 500;

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
    if (out.length >= MAX_ROWS) break;
  }
  return out;
}

/** The schedule key for an issue. */
export function scheduleKey(provider: string, repo: string, number: number): string {
  return `${provider}\u0000${repo}\u0000${number}`;
}

/** Merge issues with schedules for one provider (and optional repo). Pull requests are not rows. */
export function buildRows(issues: readonly Issue[], schedules: readonly Schedule[], provider: string, repo: string): GanttRow[] {
  const byKey = new Map<string, Schedule>();
  for (const s of schedules) byKey.set(scheduleKey(s.provider, s.repo, s.issueNumber), s);
  const out: GanttRow[] = [];
  for (const issue of issues) {
    if (issue.isPR || issue.provider !== provider) continue;
    if (repo && issue.repo !== repo) continue;
    if (issue.number === null) continue;
    const schedule = byKey.get(scheduleKey(issue.provider, issue.repo, issue.number)) ?? null;
    const { start, end } = span(schedule);
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

/** A bar's inclusive day span: explicit dates win; one date + estimate fills the other; one date alone is one day. */
export function span(s: Schedule | null): { start: number | null; end: number | null } {
  if (!s) return { start: null, end: null };
  const start = s.startDate ? dayNumber(s.startDate) : null;
  const end = s.dueDate ? dayNumber(s.dueDate) : null;
  const est = s.estimateDays !== null && s.estimateDays >= 0 ? Math.max(1, Math.round(s.estimateDays)) : 1;
  if (start !== null && end !== null) return start <= end ? { start, end } : { start: end, end: start };
  if (start !== null) return { start, end: start + est - 1 };
  if (end !== null) return { start: end - est + 1, end };
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
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { start: today - 7, days: 21 };
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

export function datedRows(rows: readonly GanttRow[]): GanttRow[] {
  return rows.filter((r) => r.start !== null && r.end !== null);
}

export function undatedRows(rows: readonly GanttRow[]): GanttRow[] {
  return rows.filter((r) => r.start === null || r.end === null);
}

/** The Mac's legend categories: closed wins, then overdue (end before today), else open. */
export type GanttCategory = "open" | "closed" | "overdue";
export const GANTT_CATEGORIES: readonly GanttCategory[] = ["open", "closed", "overdue"];

export function rowCategory(row: Pick<GanttRow, "issue" | "end">, today: number): GanttCategory {
  if (row.issue.state === "closed") return "closed";
  if (row.end !== null && row.end < today) return "overdue";
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
    const s = r.start ?? created;
    const e = r.end ?? s;
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

/** The scrollLeft that puts today about a third in from the left of the viewport. */
export function todayScrollLeft(todayLeft: number, viewportWidth: number): number {
  return Math.max(0, todayLeft - viewportWidth / 3);
}

/** Cmd/Ctrl+Enter saves the schedule editor, as the Mac's sheet does. */
export function isSaveShortcut(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}
