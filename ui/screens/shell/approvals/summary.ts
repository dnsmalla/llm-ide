// What a pending command will do, in words, from its stored args only (never a client-written summary). Every
// server-supplied string goes through safeText; unknown kinds and ids are shown as unknown, never guessed.
import { safeText } from "../safe-text";
import { rec, type PendingApproval } from "./bus-api";

export type SourceNames = Record<string, string>;

const KIND_TITLES: Readonly<Record<string, string>> = {
  "sources.update": "Sync connected sources",
  review: "Read-only review",
  "issues.from_notes": "Create issues from notes",
  "issues.implement": "Implement issues",
  "loop.run": "Run a Loop",
  "custom.run": "Run a custom task",
};
const ORIGINS: Readonly<Record<string, string>> = {
  "ios-native": "your iPhone",
  "desktop-ui": "this desktop",
  extension: "the browser extension",
  "phone-pwa": "the web app",
};
const SRC: Readonly<Record<string, string>> = { gcal: "Google Calendar", gdrive: "Google Drive", ical: "iCal feed" };
const SRC_ID = /^(gcal|gdrive|ical):([a-f0-9]{12})$/;

/** Our own title for a kind (also the notification detail): never server text. */
export const kindTitle = (kind: string): string => KIND_TITLES[kind] ?? "A job";

export function decodeSourceNames(google: unknown, ical: unknown): SourceNames {
  const out: SourceNames = {};
  const accounts = rec(google) && Array.isArray(google.accounts) ? google.accounts.slice(0, 50) : [];
  for (const a of accounts) {
    if (!rec(a) || typeof a.accountId !== "string" || !/^[a-f0-9]{12}$/.test(a.accountId)) continue;
    for (const p of Array.isArray(a.products) ? a.products : []) if (p === "gcal" || p === "gdrive") out[`${p}:${a.accountId}`] = safeText(a.email, 80);
  }
  const sources = rec(ical) && Array.isArray(ical.sources) ? ical.sources.slice(0, 50) : [];
  for (const s of sources) if (rec(s) && typeof s.sourceId === "string" && /^[a-f0-9]{12}$/.test(s.sourceId)) out[`ical:${s.sourceId}`] = safeText(s.name, 80);
  return out;
}

export function sourceLabel(id: string, names: SourceNames): string {
  const m = SRC_ID.exec(id);
  if (!m) return `${safeText(id, 60)} (not a syncable source; it will be skipped)`;
  const name = names[id];
  return name ? `${SRC[m[1]]}: ${name}` : `${SRC[m[1]]} ${m[2]} (not connected now; it will be refused)`;
}

export function summarizeApproval(a: PendingApproval, names: SourceNames): { title: string; lines: string[]; origin: string; needsConfirm: boolean } {
  const title = KIND_TITLES[a.kind] ?? `Unknown kind ${safeText(a.kind, 40)}`;
  const lines: string[] = [];
  if (a.kind === "sources.update") {
    const ids = Array.isArray(a.args.sourceIds) ? a.args.sourceIds.filter((x): x is string => typeof x === "string").slice(0, 50) : [];
    if (!ids.length) lines.push("Every connected Google Calendar, Google Drive and iCal source");
    for (const id of ids) lines.push(sourceLabel(id, names));
  } else {
    for (const [k, v] of Object.entries(a.args).slice(0, 10)) lines.push(`${safeText(k, 40)}: ${safeText(typeof v === "string" ? v : JSON.stringify(v), 120)}`);
  }
  return { title, lines, origin: ORIGINS[a.originClient] ?? safeText(a.originClient, 32), needsConfirm: a.tier === "T2" };
}

/** A T2 approval must repeat the exact ids it acts on: built from the stored args the user just read. */
export function confirmFor(a: PendingApproval): { projectId: unknown; issueIds: unknown; ship: boolean } {
  return { projectId: a.args.projectId ?? null, issueIds: Array.isArray(a.args.issueIds) ? a.args.issueIds : [], ship: a.args.ship === true };
}
