// Per-product options: what the pane shows, how a typed value is validated before it is sent, and how the
// normalised object the core stores is read back. The ranges mirror the core's own clamps
// (docs/spec/google-connectors.md sections 7, 9, 10); the core re-validates, this only avoids a round trip
// and says what is wrong in words. Pure.

import type { Product } from "./google-core.ts";

export const LABEL_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$/;
export const FOLDER_ID_RE = /^[A-Za-z0-9_-]{5,100}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const MAX_LABELS = 20;
export const MAX_CALENDARS = 20;
export const MAX_FOLDERS = 50;

export interface GmailOptions {
  labels: string[];
  windowDays: number;
  includePromotions: boolean;
  includeSocial: boolean;
}
export interface CalendarOptions {
  calendarIds: string[];
  daysBack: number;
  daysAhead: number;
}
export interface DriveOptions {
  folderIds: string[];
  includeSharedDrives: boolean;
}

export const DEFAULT_GMAIL: GmailOptions = { labels: ["INBOX"], windowDays: 30, includePromotions: false, includeSocial: false };
export const DEFAULT_CALENDAR: CalendarOptions = { calendarIds: ["primary"], daysBack: 30, daysAhead: 90 };
export const DEFAULT_DRIVE: DriveOptions = { folderIds: [], includeSharedDrives: false };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const intIn = (n: unknown, lo: number, hi: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;
const strs = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
const dedupe = (a: readonly string[]): string[] => [...new Set(a)];

export function readGmailOptions(o: unknown): GmailOptions {
  const r = isRecord(o) ? o : {};
  const labels = dedupe(strs(r.labels, MAX_LABELS).filter((l) => LABEL_RE.test(l)));
  return {
    labels: labels.length ? labels : DEFAULT_GMAIL.labels,
    windowDays: intIn(r.windowDays, 1, 365) ? r.windowDays : DEFAULT_GMAIL.windowDays,
    includePromotions: r.includePromotions === true,
    includeSocial: r.includeSocial === true,
  };
}

export function readCalendarOptions(o: unknown): CalendarOptions {
  const r = isRecord(o) ? o : {};
  const ids = dedupe(strs(r.calendarIds, MAX_CALENDARS).filter((c) => c !== "" && c.length <= 300 && !CONTROL.test(c)));
  return {
    calendarIds: ids.length ? ids : DEFAULT_CALENDAR.calendarIds,
    daysBack: intIn(r.daysBack, 0, 365) ? r.daysBack : DEFAULT_CALENDAR.daysBack,
    daysAhead: intIn(r.daysAhead, 0, 730) ? r.daysAhead : DEFAULT_CALENDAR.daysAhead,
  };
}

export function readDriveOptions(o: unknown): DriveOptions {
  const r = isRecord(o) ? o : {};
  return { folderIds: dedupe(strs(r.folderIds, MAX_FOLDERS).filter((f) => FOLDER_ID_RE.test(f))), includeSharedDrives: r.includeSharedDrives === true };
}

export type Problems = Record<string, string>;

export function validateGmailOptions(o: GmailOptions): Problems {
  const p: Problems = {};
  if (o.labels.length === 0) p.labels = "Choose at least one label (INBOX is the usual one).";
  else if (o.labels.length > MAX_LABELS) p.labels = `At most ${MAX_LABELS} labels.`;
  else if (o.labels.some((l) => !LABEL_RE.test(l))) p.labels = "A label id may use letters, digits, space, dot, dash and underscore (up to 100 characters).";
  if (!intIn(o.windowDays, 1, 365)) p.windowDays = "Use 1 to 365 days.";
  return p;
}

export function validateCalendarOptions(o: CalendarOptions): Problems {
  const p: Problems = {};
  if (o.calendarIds.length === 0) p.calendarIds = "Choose at least one calendar.";
  else if (o.calendarIds.length > MAX_CALENDARS) p.calendarIds = `At most ${MAX_CALENDARS} calendars.`;
  if (!intIn(o.daysBack, 0, 365)) p.daysBack = "Use 0 to 365 days back.";
  if (!intIn(o.daysAhead, 0, 730)) p.daysAhead = "Use 0 to 730 days ahead.";
  return p;
}

export function validateDriveOptions(o: DriveOptions): Problems {
  const p: Problems = {};
  if (o.folderIds.length > MAX_FOLDERS) p.folderIds = `At most ${MAX_FOLDERS} folders.`;
  else if (o.folderIds.some((f) => !FOLDER_ID_RE.test(f))) p.folderIds = "A folder id is not valid. Pick the folder again.";
  return p;
}

/** Splits a typed comma or newline separated list of Gmail label ids (trimmed, de-duplicated, at most `MAX_LABELS + 1`). */
export function parseLabelList(text: string): string[] {
  return dedupe(text.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== "")).slice(0, MAX_LABELS + 1);
}

/** The request body for `POST /kb/google/options`, or the problems that stop it. Never sends an invalid object. */
export function optionsPayload(product: Product, value: GmailOptions | CalendarOptions | DriveOptions): { ok: true; options: Record<string, unknown> } | { ok: false; problems: Problems } {
  const problems = product === "gmail" ? validateGmailOptions(value as GmailOptions) : product === "gcal" ? validateCalendarOptions(value as CalendarOptions) : validateDriveOptions(value as DriveOptions);
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  return { ok: true, options: { ...value } };
}

/** Whether ticked Drive folders can have their contents read: needs the content scope granted. */
export function driveContentNote(folderCount: number, contentGranted: boolean): string | null {
  if (folderCount === 0) return null;
  return contentGranted ? null : "These folders are ticked, but file contents were not allowed for this account, so only names, types and dates are indexed. Reconnect with \"index file contents\" on to read their text.";
}
