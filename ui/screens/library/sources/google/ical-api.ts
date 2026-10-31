// Google Calendar through its "Secret address in iCal format" (easy setup, no Google Cloud project, no OAuth).
//
// The SERVER connector does not exist yet (another agent adds it; the routes below are the agreed shape and the
// UI is written against this typed interface, with a fake in the tests). While the core answers 404 for them the
// card says "available after the core update".
//
//   GET  /kb/calendar-ical/status      -> { connected, calendarIdPrefix, lastSyncAt, events, lastError }
//   POST /kb/calendar-ical/connect     { url }   -> { ok, calendarIdPrefix }     (the only place the URL travels)
//   POST /kb/calendar-ical/sync        -> { events, removed, pending }
//   POST /kb/calendar-ical/disconnect  -> { ok }
//
// The address is a SECRET: anyone who has it can read the calendar. It is validated here, sent once in `connect`,
// stored write-only in the core's vault, cleared from the window at once, and never shown again: the card shows
// only the first characters of the calendar id.

import type { SourcesCore } from "../source-core.ts";
import { GoogleError, mapGoogleFailure, mapGoogleThrown, type GoogleErrorCode } from "./google-core.ts";

const ID_RE = /^[A-Za-z0-9._%@+-]{3,200}$/;
const TOKEN_RE = /^private-[A-Za-z0-9]{16,100}$/;

export type IcalUrlCheck = { ok: true; url: string; calendarIdPrefix: string; kind: "private" | "public" } | { ok: false; problem: string };

/** Shape check of the secret iCal address: https://calendar.google.com/calendar/ical/<id>/private-<token>/basic.ics */
export function validateIcalUrl(raw: string): IcalUrlCheck {
  const bad = (problem: string): IcalUrlCheck => ({ ok: false, problem });
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "") return bad("Paste the secret address in iCal format.");
  if (text.length > 600 || /[^\x21-\x7e]/.test(text)) return bad("That does not look like a calendar address (no spaces or line breaks).");
  if (!text.startsWith("https://calendar.google.com/calendar/ical/")) return bad("The address must start with https://calendar.google.com/calendar/ical/ (copy it from Calendar settings).");
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return bad("That is not a valid address.");
  }
  if (u.protocol !== "https:" || u.hostname !== "calendar.google.com" || u.port !== "" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") return bad("Use the address exactly as Google shows it, with no extra parts.");
  const seg = u.pathname.split("/");
  // ["", "calendar", "ical", id, "private-<token>" | "public", "basic.ics"]
  if (seg.length !== 6 || seg[1] !== "calendar" || seg[2] !== "ical" || seg[5] !== "basic.ics") return bad("The address must end in /basic.ics.");
  const id = seg[3]!;
  const mid = seg[4]!;
  if (!ID_RE.test(id)) return bad("The calendar id in the address is not valid.");
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    return bad("The calendar id in the address is not valid.");
  }
  if (mid !== "public" && !TOKEN_RE.test(mid)) return bad("This is not the secret address in iCal format (the part before basic.ics should start with private-).");
  return { ok: true, url: u.href, calendarIdPrefix: icalPrefix(decoded), kind: mid === "public" ? "public" : "private" };
}

/** The only part of the calendar id that is ever displayed. */
export function icalPrefix(id: string): string {
  const clean = id.replace(/[^\x21-\x7e]/g, "");
  return clean.length <= 4 ? `${clean}…` : `${clean.slice(0, 4)}…`;
}

export interface IcalStatus {
  connected: boolean;
  calendarIdPrefix: string;
  lastSyncAt: string | null;
  events: number;
  lastError: string | null;
}

export interface IcalSync {
  events: number;
  removed: number;
  pending: boolean;
}

export interface IcalApi {
  status(signal: AbortSignal): Promise<IcalStatus>;
  connect(url: string, signal: AbortSignal): Promise<{ calendarIdPrefix: string }>;
  sync(signal: AbortSignal): Promise<IcalSync>;
  disconnect(signal: AbortSignal): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const rec = (v: unknown): Record<string, unknown> => {
  if (!isRecord(v)) throw new GoogleError("bad_response");
  return v;
};

export function decodeIcalStatus(b: unknown): IcalStatus {
  const r = rec(b);
  return { connected: r.connected === true, calendarIdPrefix: typeof r.calendarIdPrefix === "string" ? r.calendarIdPrefix.slice(0, 12) : "", lastSyncAt: typeof r.lastSyncAt === "string" ? r.lastSyncAt.slice(0, 40) : null, events: int(r.events), lastError: typeof r.lastError === "string" ? r.lastError.slice(0, 100) : null };
}

export function decodeIcalSync(b: unknown): IcalSync {
  const r = rec(b);
  return { events: int(r.events), removed: int(r.removed), pending: r.pending === true };
}

const ICAL_CODES: Readonly<Record<string, GoogleErrorCode>> = { ICAL_BAD_URL: "bad_url", ICAL_FETCH_FAILED: "upstream", ICAL_BAD_FEED: "bad_response", ICAL_NOT_CONNECTED: "not_found" };

/** A 404 from a route the core does not have yet is `core_update`; known iCal codes map to plain codes. */
export function mapIcalFailure(status: number, body: unknown): GoogleError {
  const code = isRecord(body) && isRecord(body.error) && typeof body.error.code === "string" ? body.error.code.slice(0, 64) : null;
  if (code && Object.prototype.hasOwnProperty.call(ICAL_CODES, code)) return new GoogleError(ICAL_CODES[code]!, code);
  if (status === 404 && (code === null || code === "NOT_FOUND" || code === "feature_disabled" || code === "ROUTE_NOT_FOUND")) return new GoogleError("core_update", code);
  return mapGoogleFailure(status, body);
}

async function call<T>(core: SourcesCore, method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal, timeoutMs: number): Promise<T> {
  let res: { status: number; body: unknown };
  try {
    res = await core.call(method, path, body, signal, timeoutMs);
  } catch (e) {
    throw mapGoogleThrown(e, signal);
  }
  if (signal.aborted) throw new GoogleError("cancelled");
  if (res.status < 200 || res.status >= 300) throw mapIcalFailure(res.status, res.body);
  return res.body as T;
}

export function icalApiFrom(core: SourcesCore): IcalApi {
  return {
    status: async (s) => decodeIcalStatus(await call<unknown>(core, "GET", "/kb/calendar-ical/status", undefined, s, 30_000)),
    // The URL is built into the body here and nowhere else.
    connect: async (url, s) => {
      const chk = validateIcalUrl(url);
      if (!chk.ok) throw new GoogleError("bad_url");
      const r = rec(await call<unknown>(core, "POST", "/kb/calendar-ical/connect", { url: chk.url }, s, 60_000));
      return { calendarIdPrefix: typeof r.calendarIdPrefix === "string" ? r.calendarIdPrefix.slice(0, 12) : chk.calendarIdPrefix };
    },
    sync: async (s) => decodeIcalSync(await call<unknown>(core, "POST", "/kb/calendar-ical/sync", {}, s, 180_000)),
    disconnect: async (s) => void (await call<unknown>(core, "POST", "/kb/calendar-ical/disconnect", {}, s, 30_000)),
  };
}

// ---- card state machine ----------------------------------------------------------------------

export type IcalCardState = "loading" | "unavailable" | "not_connected" | "connected" | "error";

export function icalCardState(status: IcalStatus | null, error: GoogleError | null): IcalCardState {
  if (error) return error.code === "core_update" ? "unavailable" : "error";
  if (!status) return "loading";
  return status.connected ? "connected" : "not_connected";
}

export function icalSyncMessage(s: IcalSync): string {
  return `${s.events.toLocaleString()} events read${s.removed ? `; removed ${s.removed.toLocaleString()} cancelled` : ""}${s.pending ? "; more is left: sync again" : ""}.`;
}
