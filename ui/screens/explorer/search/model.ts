// Search panel state: query/options, streamed results, flattened rows and windowing. Pure.

export interface Hit {
  line: number;
  col: number;
  preview: string;
  ms: number;
  me: number;
}
export interface FileHits {
  path: string;
  hits: Hit[];
  more: boolean;
}

export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  /** Comma separated globs. */
  include: string;
  exclude: string;
  openFilesOnly: boolean;
  useIgnore: boolean;
}

export const DEFAULT_OPTIONS: SearchOptions = { regex: false, caseSensitive: false, wholeWord: false, include: "", exclude: "", openFilesOnly: false, useIgnore: true };

export type Truncation = "matches" | "files" | "time" | null;

export interface DoneInfo {
  filesScanned: number;
  filesMatched: number;
  matches: number;
  truncated: Truncation;
  cancelled: boolean;
  skippedBinary: number;
  skippedLarge: number;
  skippedOther: number;
}

/** Host events as they arrive (snake_case wire form). */
export type WireEvent =
  | { type: "chunk"; id: number; files: FileHits[] }
  | {
      type: "done";
      id: number;
      files_scanned: number;
      files_matched: number;
      matches: number;
      truncated: Truncation;
      cancelled: boolean;
      skipped_binary: number;
      skipped_large: number;
      skipped_other: number;
    };

export function decodeDone(e: Extract<WireEvent, { type: "done" }>): DoneInfo {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    filesScanned: n(e.files_scanned),
    filesMatched: n(e.files_matched),
    matches: n(e.matches),
    truncated: e.truncated === "matches" || e.truncated === "files" || e.truncated === "time" ? e.truncated : null,
    cancelled: e.cancelled === true,
    skippedBinary: n(e.skipped_binary),
    skippedLarge: n(e.skipped_large),
    skippedOther: n(e.skipped_other),
  };
}

/** Defensive decode of one chunk's files: drops anything malformed, caps what the UI will hold. */
export function decodeFiles(raw: unknown): FileHits[] {
  if (!Array.isArray(raw)) return [];
  const out: FileHits[] = [];
  for (const f of raw) {
    if (!f || typeof f !== "object" || typeof (f as FileHits).path !== "string" || !Array.isArray((f as FileHits).hits)) continue;
    const hits: Hit[] = [];
    for (const h of (f as FileHits).hits) {
      if (!h || typeof h.line !== "number" || typeof h.preview !== "string") continue;
      hits.push({ line: h.line, col: typeof h.col === "number" ? h.col : 1, preview: h.preview.slice(0, 600), ms: clampInt(h.ms, 0, h.preview.length), me: clampInt(h.me, 0, h.preview.length) });
    }
    if (hits.length) out.push({ path: (f as FileHits).path, hits, more: (f as FileHits).more === true });
  }
  return out;
}

function clampInt(v: unknown, lo: number, hi: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : lo;
  return Math.min(Math.max(n, lo), hi);
}

/** `src/**, *.ts` -> ["src/**", "*.ts"]; empty entries dropped. */
export function splitGlobs(s: string): string[] {
  return s.split(",").map((g) => g.trim()).filter((g) => g.length > 0).slice(0, 50);
}

/** Mac `normalizedQuery`: surrounding whitespace is not a search term; nothing left = nothing to search. */
export function normalizedQuery(raw: string): string | null {
  const t = raw.trim();
  return t === "" ? null : t;
}

export type Phase = "idle" | "searching" | "done" | "error";

export interface SearchState {
  query: string;
  opts: SearchOptions;
  phase: Phase;
  files: FileHits[];
  matchCount: number;
  collapsed: ReadonlySet<string>;
  done: DoneInfo | null;
  error: string | null;
  /** Index into `rows` of the keyboard-selected row, or -1. */
  selected: number;
}

export function initialSearch(): SearchState {
  return { query: "", opts: DEFAULT_OPTIONS, phase: "idle", files: [], matchCount: 0, collapsed: new Set(), done: null, error: null, selected: -1 };
}

export type Row = { kind: "file"; path: string; count: number; collapsed: boolean; more: boolean } | { kind: "hit"; path: string; hit: Hit; key: string };

export function flattenRows(files: readonly FileHits[], collapsed: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  for (const f of files) {
    const c = collapsed.has(f.path);
    rows.push({ kind: "file", path: f.path, count: f.hits.length, collapsed: c, more: f.more });
    if (!c) f.hits.forEach((hit, i) => rows.push({ kind: "hit", path: f.path, hit, key: `${f.path}:${hit.line}:${hit.col}:${i}` }));
  }
  return rows;
}

export interface Windowed {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** Fixed-height row windowing. */
export function windowRows(count: number, scrollTop: number, viewport: number, rowHeight: number, overscan = 8): Windowed {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight) + overscan);
  const start = Math.min(first, count);
  const end = Math.max(start, last);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

/** Scroll offset that brings `index` into view, or null when it already is. */
export function scrollToReveal(index: number, scrollTop: number, viewport: number, rowHeight: number): number | null {
  if (index < 0) return null;
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return null;
}

/** Next selectable row index for an arrow key (`-1` start picks the first/last). */
export function moveSelection(rows: readonly Row[], selected: number, delta: number): number {
  if (rows.length === 0) return -1;
  if (selected < 0) return delta > 0 ? 0 : rows.length - 1;
  return Math.min(rows.length - 1, Math.max(0, selected + delta));
}

export function summaryText(s: SearchState): string {
  if (s.phase === "idle") return "";
  if (s.phase === "error") return s.error ?? "Search failed";
  const files = s.files.length;
  const base = `${s.matchCount} result${s.matchCount === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
  if (s.phase === "searching") return s.matchCount === 0 ? "Searching…" : `${base}… searching`;
  const d = s.done;
  if (d?.cancelled) return `${base} (stopped)`;
  if (s.matchCount === 0) return "No results";
  return base;
}

export function truncationNotice(d: DoneInfo | null): string | null {
  if (!d) return null;
  if (d.truncated === "matches") return "Showing the first results only. Narrow the search with a more specific query or file filters.";
  if (d.truncated === "files") return "The project is very large: only part of it was searched. Use include / exclude filters.";
  if (d.truncated === "time") return "The search took too long and stopped. Use include / exclude filters to narrow it.";
  return null;
}

export function skippedNotice(d: DoneInfo | null): string | null {
  if (!d) return null;
  const parts: string[] = [];
  if (d.skippedLarge) parts.push(`${d.skippedLarge} large file${d.skippedLarge === 1 ? "" : "s"} (over 2 MB)`);
  if (d.skippedBinary) parts.push(`${d.skippedBinary} binary file${d.skippedBinary === 1 ? "" : "s"}`);
  return parts.length ? `Skipped ${parts.join(" and ")}.` : null;
}
