// The desktop's client for the command-bus approval and schedule routes (docs/spec/command-bus.md sections 3 and 9).
// Every server answer is decoded defensively; a nonce is kept in memory only and never rendered or logged.
import type { RawResponse } from "../core";

export type Raw = (path: string, init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown }) => Promise<RawResponse>;

export interface PendingApproval {
  id: string; kind: string; tier: "T0" | "T1" | "T2"; reason: "tier" | "switch_off"; originClient: string;
  args: Record<string, unknown>; createdAt: string; expiresAt: string; nonce: string;
}
export interface BusSchedule {
  id: string; kind: string; args: Record<string, unknown>; intervalHours: number; standing: boolean;
  standingUntil: string | null; createdAt: string; lastRunAt: string | null;
}
export interface ScheduleInput { kind: "sources.update"; args: { sourceIds?: string[] }; intervalHours: number; standing?: boolean; standingDays?: number }
export interface EnqueueFrame { kind: string; args: Record<string, unknown>; idem: string; ttlMs: number }

export class BusCallError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "BusCallError"; }
}

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const NONCE = /^[0-9a-f]{64}$/;
export const rec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 40) : null);

export function decodeApprovals(b: unknown): PendingApproval[] {
  if (!rec(b) || !Array.isArray(b.items)) return [];
  const out: PendingApproval[] = [];
  for (const it of b.items.slice(0, 50)) {
    if (!rec(it) || typeof it.id !== "string" || !ID.test(it.id) || typeof it.nonce !== "string" || !NONCE.test(it.nonce)) continue;
    if (it.tier !== "T0" && it.tier !== "T1" && it.tier !== "T2") continue;
    out.push({
      id: it.id, kind: str(it.kind, 64), tier: it.tier, reason: it.reason === "switch_off" ? "switch_off" : "tier",
      originClient: str(it.originClient, 32), args: rec(it.args) ? it.args : {}, createdAt: str(it.createdAt, 40),
      expiresAt: str(it.expiresAt, 40), nonce: it.nonce,
    });
  }
  return out;
}

export function decodeSchedules(b: unknown): BusSchedule[] {
  if (!rec(b) || !Array.isArray(b.items)) return [];
  const out: BusSchedule[] = [];
  for (const s of b.items.slice(0, 20)) {
    if (!rec(s) || typeof s.id !== "string" || !ID.test(s.id) || !Number.isInteger(s.intervalHours)) continue;
    const h = s.intervalHours as number;
    if (h < 1 || h > 168) continue;
    out.push({
      id: s.id, kind: str(s.kind, 64), args: rec(s.args) ? s.args : {}, intervalHours: h, standing: s.standing === true,
      standingUntil: strOrNull(s.standingUntil), createdAt: str(s.createdAt, 40), lastRunAt: strOrNull(s.lastRunAt),
    });
  }
  return out;
}

/** The new-schedule form's values -> the POST body, with the same rules the core applies. */
export function buildScheduleInput(f: { hours: number; sourceIds: string[]; standing: boolean; days: number }):
  { ok: true; input: ScheduleInput } | { ok: false; message: string } {
  if (!Number.isInteger(f.hours) || f.hours < 1 || f.hours > 168) return { ok: false, message: "Choose an interval from 1 to 168 hours." };
  const args = f.sourceIds.length ? { sourceIds: [...f.sourceIds] } : {};
  if (!f.standing) return { ok: true, input: { kind: "sources.update", args, intervalHours: f.hours } };
  if (!f.sourceIds.length) return { ok: false, message: "Pick the sources the standing approval covers." };
  if (!Number.isInteger(f.days) || f.days < 1 || f.days > 90) return { ok: false, message: "A standing approval lasts 1 to 90 days." };
  return { ok: true, input: { kind: "sources.update", args, intervalHours: f.hours, standing: true, standingDays: f.days } };
}

async function ok(p: Promise<RawResponse>): Promise<unknown> {
  const r = await p;
  if (r.status >= 200 && r.status < 300) return r.body;
  const e = rec(r.body) && rec(r.body.error) ? r.body.error : null;
  throw new BusCallError(r.status, e && typeof e.code === "string" ? e.code.slice(0, 40) : `HTTP_${r.status}`);
}
const enc = encodeURIComponent;

export function busApi(raw: Raw) {
  return {
    /** The class the core sees this UI as; only `desktop-ui` may approve or schedule. */
    kindsClient: async (): Promise<string | null> => { const b = await ok(raw("/bus/kinds")); return rec(b) && typeof b.client === "string" ? b.client : null; },
    approvals: async (): Promise<PendingApproval[]> => decodeApprovals(await ok(raw("/bus/approvals"))),
    approve: (a: PendingApproval, extra: { confirm?: Record<string, unknown>; scheduleId?: string } = {}) =>
      ok(raw(`/bus/commands/${enc(a.id)}/approve`, { method: "POST", body: { nonce: a.nonce, ...extra } })),
    deny: (id: string) => ok(raw(`/bus/commands/${enc(id)}/deny`, { method: "POST", body: {} })),
    schedules: async (): Promise<BusSchedule[]> => decodeSchedules(await ok(raw("/bus/schedules"))),
    createSchedule: (input: ScheduleInput) => ok(raw("/bus/schedules", { method: "POST", body: input })),
    deleteSchedule: (id: string) => ok(raw(`/bus/schedules/${enc(id)}`, { method: "DELETE" })),
    enqueue: (f: EnqueueFrame) => ok(raw("/bus/commands", { method: "POST", body: { v: 1, ...f } })),
    /** The raw Google and iCal lists, for `decodeSourceNames`; a failure gives empty lists (names are a nicety). */
    sourceLists: async (): Promise<[unknown, unknown]> => Promise.all([
      ok(raw("/kb/google/accounts")).catch(() => ({})), ok(raw("/kb/calendar-ical/sources")).catch(() => ({})),
    ]),
  };
}
export type BusApi = ReturnType<typeof busApi>;
