// The Self-Heal group's data (plan A: list, Ignore, Clear). Pure: decodes GET /kb/self-heal/incidents defensively and
// builds the display text. Incident text is untrusted data: it is cleaned (safeText) and rendered as text only.
import { safeText } from "../shell/safe-text.ts";

export type IncidentStatus = "new" | "fixing" | "proposed" | "ignored" | "needsHuman" | "fixed";
export type IncidentSource = "ui" | "log" | "crash" | "server";

export interface IncidentView {
  id: string;
  source: IncidentSource;
  category: string;
  message: string;
  stack: string[];
  environmental: string | null;
  firstSeen: number;
  lastSeen: number;
  count: number;
  attempts: number;
  status: IncidentStatus;
}

export const STATUS_TEXT: Readonly<Record<IncidentStatus, string>> = {
  new: "New",
  fixing: "Fixing",
  proposed: "Fix proposed",
  ignored: "Ignored",
  needsHuman: "Needs you",
  fixed: "Fixed",
};

export const SOURCE_TEXT: Readonly<Record<IncidentSource, string>> = { ui: "App", log: "Core log", crash: "Crash", server: "Core" };

const STATUSES: ReadonlySet<string> = new Set(Object.keys(STATUS_TEXT));
const SOURCES: ReadonlySet<string> = new Set(Object.keys(SOURCE_TEXT));
const ID = /^[0-9a-f]{16}$/;
const nat = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

export function decodeIncidents(raw: unknown): IncidentView[] {
  const list = raw && typeof raw === "object" ? (raw as { incidents?: unknown }).incidents : undefined;
  if (!Array.isArray(list)) return [];
  const out: IncidentView[] = [];
  for (const it of list.slice(0, 200)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const firstSeen = nat(o.firstSeen);
    const lastSeen = nat(o.lastSeen);
    const count = nat(o.count);
    const attempts = nat(o.attempts);
    if (typeof o.id !== "string" || !ID.test(o.id) || typeof o.source !== "string" || !SOURCES.has(o.source)) continue;
    if (typeof o.status !== "string" || !STATUSES.has(o.status)) continue;
    if (firstSeen === null || lastSeen === null || count === null || attempts === null) continue;
    out.push({
      id: o.id,
      source: o.source as IncidentSource,
      status: o.status as IncidentStatus,
      category: safeText(o.category, 200),
      message: safeText(o.message, 2100),
      stack: typeof o.stack === "string" ? o.stack.split("\n").slice(0, 40).map((l) => safeText(l, 500)) : [],
      environmental: typeof o.environmental === "string" ? safeText(o.environmental, 40) : null,
      firstSeen,
      lastSeen,
      count,
      attempts,
    });
  }
  return out;
}

export function incidentSummary(list: readonly IncidentView[]): string {
  if (list.length === 0) return "No incidents recorded.";
  const env = list.filter((i) => i.environmental !== null).length;
  const n = `${list.length} incident${list.length === 1 ? "" : "s"}`;
  return env > 0 ? `${n}, ${env} environmental (not app bugs).` : `${n}.`;
}
