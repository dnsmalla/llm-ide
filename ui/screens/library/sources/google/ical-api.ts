// Google Calendar through its "Secret address in iCal format" (easy setup, no Google Cloud project, no OAuth).
// Typed client for the core's multi-feed connector (spec: docs/spec/calendar-ical.md, contract:
// schema/http/calendar-ical.schema.json + its fixtures).
//
//   POST   /kb/calendar-ical/sources      { name, url }  -> { sourceId, name, nameOnly, calendarIdPrefix, host }
//   GET    /kb/calendar-ical/sources                     -> { sources: [...] }
//   DELETE /kb/calendar-ical/sources/:id                 -> { ok, purgedSources }
//   POST   /kb/calendar-ical/sync         { sourceId }   -> { sourceId, status, events, instances, cancelled, removed, truncated, warnings }
//   POST   /kb/calendar-ical/options      { sourceId, options: { daysBack, daysAhead } } -> { ok, options }
//
// The address is a SECRET (a bearer URL). It is checked here, travels only in the body of `addFeed`, is never part
// of any state this module returns, and never reaches an error: only server error CODES are kept, never messages.
// The core indexes the events itself (a Pattern A sources hub): the client writes no notes.

import type { SourcesCore } from "../source-core.ts";
import { mapGoogleThrown } from "./google-core.ts";

export const MAX_FEEDS = 10;
const MAX_LIST = 100; // hostile lists are cut here; the cap the core enforces is MAX_FEEDS
export const DAYS_BACK_MAX = 365;
export const DAYS_AHEAD_MAX = 730;
export const NAME_MAX = 100;

// ---- text hygiene ----------------------------------------------------------------------------

// Control characters, bidi controls, zero-width and line/paragraph separators: never rendered from a name.
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [[0, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb]];
const hex = (n: number): string => `\\u${n.toString(16).padStart(4, "0")}`;
const UNSAFE_TEXT = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}]`, "g");
export function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(UNSAFE_TEXT, "").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

// ---- client-side shape checks ----------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9._%@+-]{3,200}$/;
const TOKEN_RE = /^private-[A-Za-z0-9]{16,100}$/;

export type IcalUrlCheck = { ok: true; url: string; kind: "private" | "public" } | { ok: false; problem: string };

/** Shape check of the secret address: https://calendar.google.com/calendar/ical/<id>/private-<token>/basic.ics (webcal:// is read as https). */
export function validateIcalUrl(raw: string): IcalUrlCheck {
  const bad = (problem: string): IcalUrlCheck => ({ ok: false, problem });
  let text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return bad("Paste the secret address in iCal format.");
  if (text.length > 600 || /[^\x21-\x7e]/.test(text)) return bad("That does not look like a calendar address (no spaces or line breaks).");
  if (/^webcal:\/\//i.test(text)) text = `https://${text.slice(9)}`;
  if (!text.startsWith("https://calendar.google.com/calendar/ical/")) return bad("The address must start with https://calendar.google.com/calendar/ical/ (copy it from Calendar settings). Other hosts are only accepted when the core's operator allows them.");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return bad("That is not a valid address.");
  }
  if (u.protocol !== "https:" || u.hostname !== "calendar.google.com" || u.port !== "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return bad("Use the address exactly as Google shows it, with no extra parts.");
  const seg = u.pathname.split("/");
  // ["", "calendar", "ical", id, "private-<token>" | "private" | "public", "basic.ics"]
  if (seg.length !== 6 || seg[1] !== "calendar" || seg[2] !== "ical" || seg[5] !== "basic.ics") return bad("The address must end in /basic.ics.");
  if (!ID_RE.test(seg[3]!)) return bad("The calendar id in the address is not valid.");
  const mid = seg[4]!;
  if (mid !== "public" && mid !== "private" && !TOKEN_RE.test(mid)) return bad("This is not the secret address in iCal format (the part before basic.ics should start with private-).");
  return { ok: true, url: u.href, kind: mid === "public" ? "public" : "private" };
}

export type NameCheck = { ok: true; name: string } | { ok: false; problem: string };

export function validateFeedName(raw: string): NameCheck {
  const name = cleanText(raw, 1000);
  if (name === "") return { ok: false, problem: "Give the calendar a name." };
  if (name.length > NAME_MAX) return { ok: false, problem: `Use at most ${NAME_MAX} characters.` };
  return { ok: true, name };
}

export interface FeedOptions {
  daysBack: number;
  daysAhead: number;
}

export type OptionsCheck = { ok: true; options: FeedOptions } | { ok: false; problem: string };

export function validateOptions(daysBack: string, daysAhead: string): OptionsCheck {
  const parse = (s: string, max: number, label: string): number | string => {
    const t = s.trim();
    if (!/^\d{1,4}$/.test(t)) return `${label}: enter a whole number of days from 0 to ${max}.`;
    const n = Number(t);
    return n > max ? `${label}: at most ${max} days.` : n;
  };
  const b = parse(daysBack, DAYS_BACK_MAX, "Days back");
  if (typeof b === "string") return { ok: false, problem: b };
  const a = parse(daysAhead, DAYS_AHEAD_MAX, "Days ahead");
  if (typeof a === "string") return { ok: false, problem: a };
  return { ok: true, options: { daysBack: b, daysAhead: a } };
}

// ---- errors ----------------------------------------------------------------------------------

export type IcalErrorCode =
  | "validation"
  | "url_invalid"
  | "host_not_allowed"
  | "not_found"
  | "duplicate"
  | "too_many"
  | "sync_running"
  | "revoked"
  | "rate_limited"
  | "fetch_failed"
  | "too_large"
  | "parse_failed"
  | "core_update"
  | "internal"
  | "unauthorized"
  | "timeout"
  | "unavailable"
  | "bad_response"
  | "cancelled"
  | "failed";

export class IcalError extends Error {
  readonly code: IcalErrorCode;
  /** The server's error CODE (never its message), for support. */
  readonly serverCode: string | null;
  constructor(code: IcalErrorCode, serverCode: string | null = null) {
    super(code);
    this.name = "IcalError";
    this.code = code;
    this.serverCode = serverCode;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const SERVER_CODES: Readonly<Record<string, IcalErrorCode>> = {
  VALIDATION_FAILED: "validation",
  ICAL_URL_INVALID: "url_invalid",
  ICAL_HOST_NOT_ALLOWED: "host_not_allowed",
  ICAL_NOT_FOUND: "not_found",
  ICAL_DUPLICATE: "duplicate",
  ICAL_TOO_MANY_SOURCES: "too_many",
  ICAL_SYNC_RUNNING: "sync_running",
  ICAL_FEED_REVOKED: "revoked",
  ICAL_RATE_LIMITED: "rate_limited",
  ICAL_FETCH_FAILED: "fetch_failed",
  ICAL_TOO_LARGE: "too_large",
  ICAL_PARSE_FAILED: "parse_failed",
  INTERNAL: "internal",
};

/** Maps a failed answer to an `IcalError`. A 404 without a known code means the core has no such route yet. */
export function mapIcalFailure(status: number, body: unknown): IcalError {
  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code.slice(0, 64) : null;
  if (code !== null && Object.prototype.hasOwnProperty.call(SERVER_CODES, code)) return new IcalError(SERVER_CODES[code]!, code);
  if (status === 404) return new IcalError("core_update", code);
  if (status === 401) return new IcalError("unauthorized", code);
  if (status === 429) return new IcalError("rate_limited", code);
  if (status === 408 || status === 504) return new IcalError("timeout", code);
  if (status === 400 || status === 422) return new IcalError("validation", code);
  if (status === 502 || status === 503) return new IcalError("fetch_failed", code);
  return new IcalError("failed", code);
}

export function mapIcalThrown(e: unknown, signal?: AbortSignal): IcalError {
  if (e instanceof IcalError) return e;
  const g = mapGoogleThrown(e, signal);
  if (g.code === "cancelled" || g.code === "timeout" || g.code === "unauthorized" || g.code === "unavailable" || g.code === "bad_response") return new IcalError(g.code, g.serverCode);
  return new IcalError("failed", g.serverCode);
}

/** Plain wording for each code. Never includes anything the server said. */
export function icalErrorText(code: IcalErrorCode): string {
  switch (code) {
    case "validation":
      return "The core rejected these settings. Check the name and the address and try again.";
    case "url_invalid":
      return "The core did not accept that address. Copy the secret address in iCal format again from Google Calendar (it must be https and end in basic.ics).";
    case "host_not_allowed":
      return "That address is on a host the core does not allow. Only calendar.google.com is accepted unless the core's operator allows more hosts.";
    case "not_found":
      return "That calendar is not in the core any more. Reload the list.";
    case "duplicate":
      return "This calendar address is already added.";
    case "too_many":
      return `You already have ${MAX_FEEDS} calendars, the most the core allows. Delete one first.`;
    case "sync_running":
      return "A sync of this calendar is already running. Wait for it to finish, then try again.";
    case "revoked":
      return "Google no longer accepts this address: reset it in Calendar settings and add the new one. What was already indexed is kept.";
    case "rate_limited":
      return "Google asked us to slow down and the core already retried with delays. Wait a few minutes, then try again. Nothing was lost.";
    case "fetch_failed":
      return "The core could not download the calendar (network problem, timeout or a server error). Nothing was changed; try again later.";
    case "too_large":
      return "The calendar is larger than the 5 MB the core reads. Nothing was changed.";
    case "parse_failed":
      return "What the address returned is not a calendar (it may be a sign-in page). Check the address. Nothing was changed.";
    case "core_update":
      return "Available after the core update: this version of the core does not have the calendar connector yet. Nothing was changed.";
    case "internal":
      return "The core had an internal problem. Nothing was changed; try again.";
    case "unauthorized":
      return "Sign in to the core again, then retry.";
    case "timeout":
      return "This took too long. The core may still be working; check again in a moment. Nothing was lost.";
    case "unavailable":
      return "The core is not reachable. Nothing was changed.";
    case "bad_response":
      return "The core sent an answer this window could not read. Nothing was changed.";
    case "cancelled":
      return "Stopped. Anything already saved is kept; nothing is half-written.";
    case "failed":
      return "That did not work. Nothing was changed.";
  }
}

export function icalErrorLine(e: IcalError): string {
  return `${icalErrorText(e.code)}${e.serverCode ? ` (${e.serverCode})` : ""}`;
}

/** Wording for a feed's stored `lastError` (a stable code; anything else is generic). */
export function lastErrorText(raw: string | null): string | null {
  if (raw === null || raw === "") return null;
  if (Object.prototype.hasOwnProperty.call(SERVER_CODES, raw)) return icalErrorText(SERVER_CODES[raw]!);
  return "The last run did not finish. Sync again.";
}

const WARNINGS: Readonly<Record<string, string>> = {
  oversized_property: "Some very long fields in the calendar were skipped.",
  malformed_line: "Some unreadable lines in the calendar were skipped.",
  nested_vcalendar: "A calendar nested inside the calendar was ignored.",
  tz_unknown: "Some events use a time zone the core does not know; their times are read as UTC and may be off.",
  floating: "Some events have no time zone; their times are read as UTC and may be off.",
  recurrence_range_ignored: "A repeating event has a 'this and following' change that is not applied.",
  rrule_subdaily: "Some events repeat more often than daily; only their first occurrence is indexed.",
  rrule_unsupported: "Some repeating events use a rule the core does not expand; only their first occurrence is indexed.",
  rrule_invalid: "Some repeating events have a rule the core could not read; only their first occurrence is indexed.",
};

export function warningText(code: string): string {
  return Object.prototype.hasOwnProperty.call(WARNINGS, code) ? WARNINGS[code]! : "The core noted a problem it does not describe here; the rest of the calendar was read.";
}

// ---- decoders --------------------------------------------------------------------------------

export type FeedStatus = "idle" | "error" | "revoked";

export interface Feed {
  sourceId: string;
  name: string;
  calendarIdPrefix: string;
  host: string;
  status: FeedStatus;
  lastRunAt: string | null;
  lastError: string | null;
  options: FeedOptions;
}

export interface AddedFeed {
  sourceId: string;
  name: string;
  calendarIdPrefix: string;
  host: string;
}

export type SyncStatus = "ok" | "unchanged" | "not_modified";

export interface FeedSync {
  sourceId: string;
  status: SyncStatus;
  events: number;
  instances: number;
  cancelled: number;
  removed: number;
  truncated: boolean;
  warnings: string[];
}

const SOURCE_ID_RE = /^[0-9a-f]{12}$/;
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
const clampInt = (v: unknown, max: number, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 0), max) : dflt);
const rec = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new IcalError("bad_response");
  return v;
};
const id = (v: unknown): string => {
  if (typeof v !== "string" || !SOURCE_ID_RE.test(v)) throw new IcalError("bad_response");
  return v;
};
const hint = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[^\x21-\x7e]/g, "").slice(0, max) : "");

function decodeOptions(v: unknown): FeedOptions {
  const o = isRecord(v) ? v : {};
  return { daysBack: clampInt(o.daysBack, DAYS_BACK_MAX, 30), daysAhead: clampInt(o.daysAhead, DAYS_AHEAD_MAX, 90) };
}

export function decodeFeeds(b: unknown): Feed[] {
  const r = rec(b);
  if (!Array.isArray(r.sources)) throw new IcalError("bad_response");
  const out: Feed[] = [];
  for (const s of r.sources.slice(0, MAX_LIST)) {
    if (!isRecord(s) || typeof s.sourceId !== "string" || !SOURCE_ID_RE.test(s.sourceId)) continue;
    out.push({
      sourceId: s.sourceId,
      name: cleanText(s.name, NAME_MAX) || "(unnamed)",
      calendarIdPrefix: hint(s.calendarIdPrefix, 16),
      host: hint(s.host, 253),
      status: s.status === "idle" || s.status === "revoked" ? s.status : "error",
      lastRunAt: typeof s.lastRunAt === "string" ? s.lastRunAt.slice(0, 40) : null,
      lastError: typeof s.lastError === "string" ? s.lastError.slice(0, 64) : null,
      options: decodeOptions(s.options),
    });
  }
  return out;
}

export function decodeAdded(b: unknown): AddedFeed {
  const r = rec(b);
  if (r.nameOnly !== true) throw new IcalError("bad_response");
  return { sourceId: id(r.sourceId), name: cleanText(r.name, NAME_MAX), calendarIdPrefix: hint(r.calendarIdPrefix, 16), host: hint(r.host, 253) };
}

export function decodeSync(b: unknown): FeedSync {
  const r = rec(b);
  if (r.status !== "ok" && r.status !== "unchanged" && r.status !== "not_modified") throw new IcalError("bad_response");
  const warnings = Array.isArray(r.warnings) ? [...new Set(r.warnings.filter((w): w is string => typeof w === "string").map((w) => w.slice(0, 40)))].slice(0, 20) : [];
  return { sourceId: id(r.sourceId), status: r.status, events: int(r.events), instances: int(r.instances), cancelled: int(r.cancelled), removed: int(r.removed), truncated: r.truncated === true, warnings };
}

export function decodeDeleted(b: unknown): { purgedSources: number } {
  const r = rec(b);
  if (r.ok !== true) throw new IcalError("bad_response");
  return { purgedSources: int(r.purgedSources) };
}

export function decodeOptionsReply(b: unknown): FeedOptions {
  const r = rec(b);
  if (r.ok !== true) throw new IcalError("bad_response");
  return decodeOptions(r.options);
}

// ---- api -------------------------------------------------------------------------------------

export interface IcalApi {
  list(signal: AbortSignal): Promise<Feed[]>;
  /** The secret address travels here and nowhere else. */
  add(name: string, url: string, signal: AbortSignal): Promise<AddedFeed>;
  remove(sourceId: string, signal: AbortSignal): Promise<{ purgedSources: number }>;
  sync(sourceId: string, signal: AbortSignal): Promise<FeedSync>;
  setOptions(sourceId: string, options: FeedOptions, signal: AbortSignal): Promise<FeedOptions>;
}

async function call(core: SourcesCore, method: "GET" | "POST" | "DELETE", path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
  let res: { status: number; body: unknown };
  try {
    res = await core.call(method, path, body, signal, timeoutMs);
  } catch (e) {
    throw mapIcalThrown(e, signal);
  }
  if (signal.aborted) throw new IcalError("cancelled");
  if (res.status < 200 || res.status >= 300) throw mapIcalFailure(res.status, res.body);
  return res.body;
}

export function icalApiFrom(core: SourcesCore): IcalApi {
  return {
    list: async (s) => decodeFeeds(await call(core, "GET", "/kb/calendar-ical/sources", undefined, s, 30_000)),
    add: async (name, url, s) => {
      const n = validateFeedName(name);
      const u = validateIcalUrl(url);
      if (!n.ok || !u.ok) throw new IcalError("validation");
      return decodeAdded(await call(core, "POST", "/kb/calendar-ical/sources", { name: n.name, url: u.url }, s, 60_000));
    },
    remove: async (sourceId, s) => decodeDeleted(await call(core, "DELETE", `/kb/calendar-ical/sources/${encodeURIComponent(id(sourceId))}`, undefined, s, 30_000)),
    sync: async (sourceId, s) => decodeSync(await call(core, "POST", "/kb/calendar-ical/sync", { sourceId: id(sourceId) }, s, 180_000)),
    setOptions: async (sourceId, options, s) => {
      const o = validateOptions(String(options.daysBack), String(options.daysAhead));
      if (!o.ok) throw new IcalError("validation");
      return decodeOptionsReply(await call(core, "POST", "/kb/calendar-ical/options", { sourceId: id(sourceId), options: o.options }, s, 30_000));
    },
  };
}

// ---- words for results -----------------------------------------------------------------------

export function syncMessage(s: FeedSync): string {
  const head =
    s.status === "not_modified"
      ? "Google says the calendar has not changed since the last sync."
      : s.status === "unchanged"
        ? "The calendar is identical to the last sync; nothing was rewritten."
        : `${s.events.toLocaleString()} events read, ${s.instances.toLocaleString()} occurrences indexed in the core, ${s.cancelled.toLocaleString()} cancelled, ${s.removed.toLocaleString()} removed.`;
  return `${head}${s.truncated ? " The calendar is bigger than the core's limits, so only part of it was indexed and nothing was removed; shorten the window (days back or ahead) and sync again." : ""}`;
}

export const OPTIONS_CHANGED_NOTE = "Changing the window makes the next sync read the whole calendar again.";

export const DELETE_WORD = "delete";

/** Explanation shown before a delete; the typed confirmation is `DELETE_WORD`. */
export function deleteExplanation(name: string): string {
  return `Delete ${name}: this removes its secret address from the core's vault and the calendar events the core indexed from it. To make the old address useless, also reset the secret address in Google Calendar.`;
}

export function statusLabel(s: FeedStatus): string {
  return s === "idle" ? "Ready" : s === "revoked" ? "Address no longer accepted" : "Last sync failed";
}
