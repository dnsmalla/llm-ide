// The Library's note model: path-derived facts (cheap, known for every listed file), head-derived
// facts (frontmatter, read lazily in batches), classification into sections, filtering, sorting
// and the flattened rows the virtualised list renders. Pure; tested with node.
//
// Layout it understands (the Mac app's, mac/.../Core/Notes + ProjectLayout):
//   source/<raw dir>/YYYY/MM/<file>   raw captures and fetched items (meetings, emails, slack, ...)
//   llm-doc/<type dir>/<...>/<file>   generated notes, grouped by type dir
//   anything else                     notes-folder layout (meeting files, user notes)
//
// Classification mirrors LibraryItemStore.sourceId: explicit frontmatter `platform` (then `source`)
// first, then the raw directory under `source/`, then the historical "meeting" default for an
// unknown but non-empty platform. DIFFERENCE (Q19, recorded in the parity checklist): a note with
// NO `platform` and no owning raw directory is invisible in the Mac Library (it fails the meeting
// index decode); here it is listed under "Unsorted".

import { fmDateMs, fmInt, fmList, fmString, parseHead } from "./frontmatter.ts";

export interface NoteEntry {
  rel: string;
  size: number;
  mtimeMs: number;
  /** Not downloaded (iCloud): listed, never read. */
  placeholder: boolean;
}

export type Area = "source" | "llm-doc" | "other";

export interface NoteRecord {
  rel: string;
  /** File name without directories. */
  name: string;
  size: number;
  mtimeMs: number;
  placeholder: boolean;
  area: Area;
  /** First directory under `source/` or `llm-doc/` (the raw dir or the note type), else "". */
  typeDir: string;
  /** Section the note is shown in (see `sectionOf`). Provisional until `headRead`. */
  sourceId: string;
  title: string;
  titleFromPath: boolean;
  /** Best date: frontmatter start, else the date in the path, else mtime. */
  dateMs: number;
  participants: string[];
  platform: string | null;
  gist: string | null;
  durationSec: number | null;
  hasFrontmatter: boolean;
  headRead: boolean;
}

export const UNSORTED = "unsorted";

/** Frontmatter `platform` values each source owns (SourceRegistry / InputSource.platforms). */
export const PLATFORM_SOURCES: Readonly<Record<string, string>> = {
  meet: "meeting",
  teams: "meeting",
  zoom: "meeting",
  mic: "meeting",
  email: "email",
  slack: "slack",
};

/** Raw directory under `source/` -> source id (NoteType.directoryName: plural for the legacy three). */
export const RAW_DIR_SOURCES: Readonly<Record<string, string>> = {
  meetings: "meeting",
  emails: "email",
  slack: "slack",
};

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  meeting: "Meetings",
  email: "Mail",
  slack: "Slack",
  [UNSORTED]: "Unsorted",
};

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})(?:[-_ T]?(\d{2})(\d{2}))?/;
const ID_SUFFIX = /-[0-9a-f]{8}$/i;

export function areaOf(rel: string): { area: Area; typeDir: string } {
  const segs = rel.split("/");
  if (segs.length >= 2 && segs[0] === "source") return { area: "source", typeDir: segs.length > 2 ? segs[1]! : "" };
  if (segs.length >= 2 && segs[0] === "llm-doc") return { area: "llm-doc", typeDir: segs.length > 2 ? segs[1]! : "" };
  return { area: "other", typeDir: "" };
}

/** Title from a file name: drop extension, date prefix and the 8-hex id suffix; dashes and underscores to spaces. */
export function titleFromName(name: string): string {
  let stem = name.replace(/\.(md|markdown|txt)$/i, "");
  stem = stem.replace(DATE_PREFIX, "").replace(/^[-_ ]+/, "");
  stem = stem.replace(ID_SUFFIX, "");
  const t = stem.replace(/[-_]+/g, " ").trim();
  return t === "" ? name.replace(/\.(md|markdown|txt)$/i, "") : t;
}

/** Local date from `YYYY-MM-DD[-HHmm]` in the file name (the Mac writes local time), else `/YYYY/MM/` in the path, else null. */
export function dateFromPath(rel: string): number | null {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const m = DATE_PREFIX.exec(name);
  if (m) {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime();
    if (Number.isFinite(t) && Number(m[2]) >= 1 && Number(m[2]) <= 12) return t;
  }
  const p = /(?:^|\/)(\d{4})\/(\d{2})(?:\/|$)/.exec(rel);
  if (p && Number(p[2]) >= 1 && Number(p[2]) <= 12) return new Date(Number(p[1]), Number(p[2]) - 1, 1).getTime();
  return null;
}

/** The record for a listed file before its head is read. */
export function recordFromEntry(e: NoteEntry): NoteRecord {
  const name = e.rel.slice(e.rel.lastIndexOf("/") + 1);
  const { area, typeDir } = areaOf(e.rel);
  const rec: NoteRecord = {
    rel: e.rel,
    name,
    size: e.size,
    mtimeMs: e.mtimeMs,
    placeholder: e.placeholder,
    area,
    typeDir,
    sourceId: UNSORTED,
    title: titleFromName(name),
    titleFromPath: true,
    dateMs: dateFromPath(e.rel) ?? e.mtimeMs,
    participants: [],
    platform: null,
    gist: null,
    durationSec: null,
    hasFrontmatter: false,
    headRead: false,
  };
  rec.sourceId = classify(rec);
  return rec;
}

/** Folds a file head (first KBs of text) into a record. Unreadable or placeholder files keep their path facts. */
export function applyHead(rec: NoteRecord, head: string): NoteRecord {
  const parsed = parseHead(head);
  const d = parsed.data;
  const title = fmString(d, "title");
  const next: NoteRecord = {
    ...rec,
    headRead: true,
    hasFrontmatter: parsed.hasFrontmatter,
    title: title ?? firstHeading(parsed.body) ?? rec.title,
    titleFromPath: title === null && firstHeading(parsed.body) === null,
    dateMs: fmDateMs(d, "started_at") ?? fmDateMs(d, "date") ?? rec.dateMs,
    participants: fmList(d, "participants").slice(0, 50),
    platform: (fmString(d, "platform") ?? fmString(d, "source") ?? "").trim().toLowerCase() || null,
    gist: fmString(d, "gist"),
    durationSec: fmInt(d, "duration_seconds"),
  };
  next.sourceId = classify(next);
  return next;
}

function firstHeading(body: string): string | null {
  const m = /^#{1,3}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body.slice(0, 2000));
  const t = m?.[1]?.trim();
  return t ? t.slice(0, 200) : null;
}

/** Section id for a note: `llm-doc` notes by type dir, everything else by source (see the module comment). */
export function classify(rec: NoteRecord): string {
  if (rec.area === "llm-doc") return `doc:${rec.typeDir}`;
  const byRawDir = rec.area === "source" ? RAW_DIR_SOURCES[rec.typeDir] : undefined;
  const byDir = byRawDir ?? (rec.area === "source" && rec.typeDir && rec.typeDir !== "documents" ? `dir:${rec.typeDir}` : null);
  if (rec.headRead && rec.platform) {
    // An unknown, non-empty platform: the raw directory decides, else the historical meeting default.
    return PLATFORM_SOURCES[rec.platform] ?? byDir ?? "meeting";
  }
  return byDir ?? UNSORTED;
}

// ---- sections ---------------------------------------------------------------------------

export interface SectionDef {
  id: string;
  label: string;
  group: "sources" | "docs";
}

export function sectionLabel(id: string): string {
  if (id in SOURCE_LABELS) return SOURCE_LABELS[id]!;
  if (id.startsWith("dir:")) return titleCase(id.slice(4));
  if (id.startsWith("doc:")) {
    const t = id.slice(4);
    return t === "" ? "General" : titleCase(t);
  }
  return id;
}

function titleCase(s: string): string {
  const t = s.replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const SOURCE_ORDER = ["meeting", "email", "slack"];

/** Sections present in `counts`, always showing the three built-in sources, in a stable order. */
export function sectionsFor(counts: ReadonlyMap<string, number>): SectionDef[] {
  const sources = new Set<string>(SOURCE_ORDER);
  const docs: string[] = [];
  for (const id of counts.keys()) {
    if (id.startsWith("doc:")) docs.push(id);
    else sources.add(id);
  }
  sources.delete(UNSORTED);
  const out: SectionDef[] = [];
  const rest = [...sources].filter((s) => !SOURCE_ORDER.includes(s)).sort((a, b) => sectionLabel(a).localeCompare(sectionLabel(b)));
  for (const id of [...SOURCE_ORDER, ...rest]) out.push({ id, label: sectionLabel(id), group: "sources" });
  if ((counts.get(UNSORTED) ?? 0) > 0) out.push({ id: UNSORTED, label: sectionLabel(UNSORTED), group: "sources" });
  for (const id of docs.sort((a, b) => sectionLabel(a).localeCompare(sectionLabel(b)))) out.push({ id, label: sectionLabel(id), group: "docs" });
  return out;
}

export function countBySection(records: Iterable<NoteRecord>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of records) m.set(r.sourceId, (m.get(r.sourceId) ?? 0) + 1);
  return m;
}

// ---- filtering, sorting, rows -----------------------------------------------------------

export type DateRange = "all" | "7d" | "30d" | "year";

export interface Filters {
  /** Local text filter over title, path, gist, participants. */
  query: string;
  platform: string | null;
  hasSummary: boolean;
  range: DateRange;
}

export const NO_FILTERS: Filters = { query: "", platform: null, hasSummary: false, range: "all" };

export function filtersActive(f: Filters): boolean {
  return f.query.trim() !== "" || f.platform !== null || f.hasSummary || f.range !== "all";
}

const RANGE_MS: Record<Exclude<DateRange, "all">, number> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, year: 365 * 86_400_000 };

export function matchesFilters(r: NoteRecord, f: Filters, now: number): boolean {
  if (f.platform !== null && r.platform !== f.platform) return false;
  if (f.hasSummary && !(r.gist && r.gist.trim() !== "")) return false;
  if (f.range !== "all" && r.dateMs < now - RANGE_MS[f.range]) return false;
  const q = f.query.trim().toLowerCase();
  if (q !== "") {
    for (const term of q.split(/\s+/)) {
      const hay = `${r.title}\n${r.rel}\n${r.gist ?? ""}\n${r.participants.join(" ")}`.toLowerCase();
      if (!hay.includes(term)) return false;
    }
  }
  return true;
}

export type SortKey = "date-desc" | "date-asc" | "title" | "path";
export type GroupKey = "month" | "folder" | "none";

export function compareRecords(sort: SortKey): (a: NoteRecord, b: NoteRecord) => number {
  switch (sort) {
    case "date-asc":
      return (a, b) => a.dateMs - b.dateMs || cmp(a.rel, b.rel);
    case "title":
      return (a, b) => a.title.localeCompare(b.title) || cmp(a.rel, b.rel);
    case "path":
      return (a, b) => cmp(a.rel, b.rel);
    default:
      return (a, b) => b.dateMs - a.dateMs || cmp(a.rel, b.rel);
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type Row = { kind: "header"; key: string; label: string; count: number } | { kind: "note"; rec: NoteRecord };

export function monthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function folderKey(r: NoteRecord): string {
  const i = r.rel.lastIndexOf("/");
  return i < 0 ? "(root)" : r.rel.slice(0, i);
}

/** Filters, sorts and groups one section's notes into the flat rows the list renders. */
export function buildRows(records: readonly NoteRecord[], opts: { sectionId: string | null; filters: Filters; sort: SortKey; group: GroupKey; now: number }): Row[] {
  const picked = records.filter((r) => (opts.sectionId === null || r.sourceId === opts.sectionId) && matchesFilters(r, opts.filters, opts.now));
  picked.sort(compareRecords(opts.sort));
  if (opts.group === "none") return picked.map((rec) => ({ kind: "note", rec }));
  const keyOf = opts.group === "month" ? (r: NoteRecord) => monthKey(r.dateMs) : folderKey;
  const rows: Row[] = [];
  let cur: string | null = null;
  let header: Extract<Row, { kind: "header" }> | null = null;
  for (const rec of picked) {
    const k = keyOf(rec);
    if (k !== cur) {
      cur = k;
      header = { kind: "header", key: k, label: k, count: 0 };
      rows.push(header);
    }
    header!.count += 1;
    rows.push({ kind: "note", rec });
  }
  return rows;
}

/** Index of `rel` among note rows, or -1. */
export function rowIndexOf(rows: readonly Row[], rel: string): number {
  return rows.findIndex((r) => r.kind === "note" && r.rec.rel === rel);
}

/** Next or previous NOTE row index from `from` (headers skipped); stays on `from` at an end; -1 when there are no notes. */
export function stepNoteRow(rows: readonly Row[], from: number, delta: 1 | -1): number {
  for (let i = from + delta; i >= 0 && i < rows.length; i += delta) {
    if (rows[i]!.kind === "note") return i;
  }
  if (from >= 0 && from < rows.length && rows[from]!.kind === "note") return from;
  if (delta === 1) return rows.findIndex((r) => r.kind === "note");
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.kind === "note") return i;
  return -1;
}

export function formatDuration(sec: number | null): string | null {
  if (sec === null || sec <= 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${sec}s`;
}

export function formatDate(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
