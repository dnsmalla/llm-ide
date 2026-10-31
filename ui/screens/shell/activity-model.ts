// The activity feed (Mac `ActivityStore` + `ActivityBell`): decode `GET /kb/activity`, drop what is older than 48 hours,
// group by day. Pure. Titles and kinds are server/agent text: they are decoded to bounded strings here and rendered as
// text only; a feed link is never turned into an anchor (the Mac does not either).
import { safeText } from "./safe-text";

export interface ActivityItem {
  id: number;
  kind: string | null;
  title: string;
  /** Epoch ms (the server sends SQLite UTC `YYYY-MM-DD HH:MM:SS`). */
  at: number;
}

export interface ActivityFeed {
  items: ActivityItem[];
  unread: number;
  lastId: number;
}

/** The feed shows at most this many rows (the route caps a page at 200; a bell popover needs far fewer). */
export const MAX_FEED_ROWS = 50;
/** Rows older than this are hidden ("No activity in the last 48 hours"). */
export const FEED_WINDOW_MS = 48 * 60 * 60 * 1000;

export const EMPTY_FEED: ActivityFeed = Object.freeze({ items: [], unread: 0, lastId: 0 }) as ActivityFeed;

const asInt = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** SQLite `datetime('now')` (UTC, no zone) or an ISO string -> epoch ms; NaN when unparsable. */
export function parseServerTime(raw: unknown): number {
  if (typeof raw !== "string" || raw.length > 40) return Number.NaN;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  return Date.parse(iso);
}

/** Defensive decode: anything malformed reads as an empty feed; a bad row is skipped, never fatal. */
export function decodeFeed(raw: unknown): ActivityFeed {
  if (!raw || typeof raw !== "object") return EMPTY_FEED;
  const r = raw as Record<string, unknown>;
  const rows = Array.isArray(r.items) ? r.items.slice(0, 200) : [];
  const items: ActivityItem[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const id = asInt(o.id);
    const title = safeText(o.title, 200);
    const at = parseServerTime(o.created_at);
    if (id === null || title === "" || Number.isNaN(at)) continue;
    items.push({ id, kind: typeof o.kind === "string" ? safeText(o.kind, 40) || null : null, title, at });
  }
  return { items, unread: asInt(r.unread) ?? 0, lastId: asInt(r.lastId) ?? items.reduce((m, i) => Math.max(m, i.id), 0) };
}

/** Newest first, within the window, at most `MAX_FEED_ROWS`. */
export function visibleItems(items: readonly ActivityItem[], nowMs: number): ActivityItem[] {
  return items
    .filter((i) => nowMs - i.at <= FEED_WINDOW_MS)
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .slice(0, MAX_FEED_ROWS);
}

export interface DayGroup {
  label: string;
  items: ActivityItem[];
}

const DAY = 24 * 60 * 60 * 1000;

/** "Today" / "Yesterday" / a short date, by local calendar day. */
export function groupByDay(items: readonly ActivityItem[], nowMs: number, tzOffsetMin: number = new Date(nowMs).getTimezoneOffset()): DayGroup[] {
  const local = (ms: number) => Math.floor((ms - tzOffsetMin * 60_000) / DAY);
  const today = local(nowMs);
  const groups: DayGroup[] = [];
  for (const it of items) {
    const d = local(it.at);
    const label = d === today ? "Today" : d === today - 1 ? "Yesterday" : new Date(d * DAY).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(it);
    else groups.push({ label, items: [it] });
  }
  return groups;
}

/** Badge text: nothing at zero, capped at 99. */
export function badgeText(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return String(Math.min(Math.floor(unread), 99));
}
