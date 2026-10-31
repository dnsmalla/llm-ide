// Pure model of the virtualised file tree. Nothing here touches the DOM or the host.
//
// Big projects: a folder is loaded in fixed-size PAGES (the host sorts once and serves slices),
// and the tree is described as SEGMENTS (a run of entries of one page, a not-yet-loaded page, a
// status line), not as one row object per entry. A 100k-entry folder is then ~200 segments plus
// the entry objects the host returned; scrolling renders only the window and asks for the pages
// the window touches. Layout is rebuilt on expand/collapse/load, never on scroll.
import type { Entry } from "./fs";

export const PAGE_SIZE = 500;
export const ROW_HEIGHT = 22;

export interface DirState {
  total: number;
  pages: Map<number, Entry[]>;
  loading: Set<number>;
  error: string | null;
}

export interface TreeState {
  pageSize: number;
  dirs: Map<string, DirState>;
  expanded: Set<string>;
}

export function emptyTree(pageSize = PAGE_SIZE): TreeState {
  return { pageSize, dirs: new Map(), expanded: new Set([""]) };
}

export function newDir(total = 0): DirState {
  return { total, pages: new Map(), loading: new Set(), error: null };
}

export type Row =
  | { kind: "entry"; entry: Entry; depth: number; expanded: boolean }
  | { kind: "gap"; dir: string; page: number; depth: number }
  | { kind: "status"; dir: string; depth: number; text: "empty" | "loading" | "error"; message?: string };

type Seg =
  | { kind: "run"; entries: Entry[]; from: number; to: number; depth: number }
  | { kind: "gap"; dir: string; page: number; depth: number; count: number }
  | { kind: "status"; dir: string; depth: number; text: "empty" | "loading" | "error"; message?: string };

export interface Layout {
  count: number;
  segs: Seg[];
  starts: number[];
}

/** Rows visible with the root's children at depth 0. */
export function buildLayout(state: TreeState): Layout {
  const segs: Seg[] = [];
  const starts: number[] = [];
  let count = 0;
  const push = (s: Seg, len: number) => {
    segs.push(s);
    starts.push(count);
    count += len;
  };
  const walk = (dir: string, depth: number) => {
    const d = state.dirs.get(dir);
    if (!d) {
      push({ kind: "status", dir, depth, text: "loading" }, 1);
      return;
    }
    if (d.error && d.pages.size === 0) {
      push({ kind: "status", dir, depth, text: "error", message: d.error }, 1);
      return;
    }
    if (d.total === 0) {
      push({ kind: "status", dir, depth, text: "empty" }, 1);
      return;
    }
    const pageCount = Math.ceil(d.total / state.pageSize);
    for (let p = 0; p < pageCount; p++) {
      const page = d.pages.get(p);
      if (!page) {
        push({ kind: "gap", dir, page: p, depth, count: Math.min(state.pageSize, d.total - p * state.pageSize) }, Math.min(state.pageSize, d.total - p * state.pageSize));
        continue;
      }
      let runStart = 0;
      for (let i = 0; i < page.length; i++) {
        const e = page[i]!;
        if (e.kind === "dir" && state.expanded.has(e.path)) {
          push({ kind: "run", entries: page, from: runStart, to: i + 1, depth }, i + 1 - runStart);
          walk(e.path, depth + 1);
          runStart = i + 1;
        }
      }
      if (runStart < page.length) push({ kind: "run", entries: page, from: runStart, to: page.length, depth }, page.length - runStart);
    }
  };
  walk("", 0);
  return { count, segs, starts };
}

function segIndex(l: Layout, i: number): number {
  let lo = 0;
  let hi = l.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (l.starts[mid]! <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Rows `[from, to)` (clamped). Cost is O(segments touched + rows returned). */
export function rowsInRange(l: Layout, from: number, to: number, state: TreeState): Row[] {
  const out: Row[] = [];
  const a = Math.max(0, from);
  const b = Math.min(l.count, to);
  if (a >= b) return out;
  let si = segIndex(l, a);
  for (let i = a; i < b; ) {
    const seg = l.segs[si]!;
    const start = l.starts[si]!;
    const off = i - start;
    if (seg.kind === "run") {
      const e = seg.entries[seg.from + off]!;
      out.push({ kind: "entry", entry: e, depth: seg.depth, expanded: e.kind === "dir" && state.expanded.has(e.path) });
      i++;
      if (seg.from + off + 1 >= seg.to) si++;
    } else if (seg.kind === "gap") {
      out.push({ kind: "gap", dir: seg.dir, page: seg.page, depth: seg.depth });
      i++;
      if (off + 1 >= seg.count) si++;
    } else {
      out.push({ kind: "status", dir: seg.dir, depth: seg.depth, text: seg.text, message: seg.message });
      i++;
      si++;
    }
  }
  return out;
}

/** Row index of `path`, or -1 when it is not currently a visible, loaded entry. O(loaded entries). */
export function indexOfPath(l: Layout, path: string): number {
  for (let s = 0; s < l.segs.length; s++) {
    const seg = l.segs[s]!;
    if (seg.kind !== "run") continue;
    for (let k = seg.from; k < seg.to; k++) if (seg.entries[k]!.path === path) return l.starts[s]! + (k - seg.from);
  }
  return -1;
}

export interface WindowRange {
  start: number;
  /** Exclusive. */
  end: number;
  padTop: number;
  padBottom: number;
  totalHeight: number;
}

export function windowRange(count: number, scrollTop: number, viewportHeight: number, rowHeight = ROW_HEIGHT, overscan = 8): WindowRange {
  const totalHeight = count * rowHeight;
  if (count === 0 || viewportHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: totalHeight, totalHeight };
  const first = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
  const last = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight, totalHeight };
}

/** Pages the window needs that are neither loaded nor loading. */
export function pagesNeeded(rows: Row[], state: TreeState): { dir: string; page: number }[] {
  const seen = new Set<string>();
  const out: { dir: string; page: number }[] = [];
  for (const r of rows) {
    if (r.kind !== "gap") continue;
    const d = state.dirs.get(r.dir);
    if (d?.loading.has(r.page)) continue;
    const key = `${r.dir}\0${r.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir: r.dir, page: r.page });
  }
  return out;
}

/** Expanded folders that have no listing yet. */
export function unloadedExpanded(state: TreeState): string[] {
  return [...state.expanded].filter((p) => !state.dirs.has(p));
}

// ---- keyboard ------------------------------------------------------------------------

export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" | "Enter";

export type NavAction =
  | { type: "focus-index"; index: number }
  | { type: "expand"; path: string }
  | { type: "collapse"; path: string }
  | { type: "focus-path"; path: string }
  | { type: "open"; path: string }
  | { type: "toggle"; path: string }
  | null;

/** What a navigation key does when `focusPath` is focused (`null`: nothing focused yet). */
export function navigate(l: Layout, state: TreeState, focusPath: string | null, key: NavKey, pageRows = 10): NavAction {
  if (l.count === 0) return null;
  const idx = focusPath === null ? -1 : indexOfPath(l, focusPath);
  const clamp = (i: number) => Math.max(0, Math.min(l.count - 1, i));
  const cur = idx < 0 ? null : (rowsInRange(l, idx, idx + 1, state)[0] ?? null);
  switch (key) {
    case "ArrowDown": return { type: "focus-index", index: clamp(idx < 0 ? 0 : idx + 1) };
    case "ArrowUp": return { type: "focus-index", index: clamp(idx < 0 ? 0 : idx - 1) };
    case "Home": return { type: "focus-index", index: 0 };
    case "End": return { type: "focus-index", index: l.count - 1 };
    case "PageDown": return { type: "focus-index", index: clamp((idx < 0 ? 0 : idx) + pageRows) };
    case "PageUp": return { type: "focus-index", index: clamp((idx < 0 ? 0 : idx) - pageRows) };
    case "ArrowRight":
      if (cur?.kind !== "entry" || cur.entry.kind !== "dir") return null;
      return cur.expanded ? { type: "focus-index", index: clamp(idx + 1) } : { type: "expand", path: cur.entry.path };
    case "ArrowLeft": {
      if (cur?.kind !== "entry") return null;
      if (cur.entry.kind === "dir" && cur.expanded) return { type: "collapse", path: cur.entry.path };
      const slash = cur.entry.path.lastIndexOf("/");
      return slash < 0 ? null : { type: "focus-path", path: cur.entry.path.slice(0, slash) };
    }
    case "Enter":
      if (cur?.kind !== "entry") return null;
      return cur.entry.kind === "dir" ? { type: "toggle", path: cur.entry.path } : cur.entry.kind === "file" ? { type: "open", path: cur.entry.path } : null;
  }
}

/** Index of the next entry row (after `fromIndex`, wrapping) whose name starts with `prefix`. */
export function typeAhead(l: Layout, state: TreeState, fromIndex: number, prefix: string, scanLimit = 20000): number {
  if (!prefix || l.count === 0) return -1;
  const p = prefix.toLowerCase();
  let remaining = Math.min(l.count, scanLimit);
  let a = (fromIndex + 1) % l.count;
  while (remaining > 0) {
    const len = Math.min(512, remaining, l.count - a);
    const rows = rowsInRange(l, a, a + len, state);
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k]!;
      if (r.kind === "entry" && r.entry.name.toLowerCase().startsWith(p)) return a + k;
    }
    remaining -= len;
    a = (a + len) % l.count;
  }
  return -1;
}

// ---- selection -------------------------------------------------------------------------

export interface Selection {
  anchor: string | null;
  paths: ReadonlySet<string>;
}

export const NO_SELECTION: Selection = { anchor: null, paths: new Set() };
const RANGE_CAP = 10000;

export interface Mods {
  shift: boolean;
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  toggle: boolean;
}

export function applySelect(sel: Selection, l: Layout, state: TreeState, path: string, m: Mods): Selection {
  if (m.shift && sel.anchor !== null) {
    const a = indexOfPath(l, sel.anchor);
    const b = indexOfPath(l, path);
    if (a >= 0 && b >= 0) {
      const lo = Math.min(a, b);
      const hi = Math.min(Math.max(a, b) + 1, lo + RANGE_CAP);
      const paths = new Set<string>();
      for (const r of rowsInRange(l, lo, hi, state)) if (r.kind === "entry") paths.add(r.entry.path);
      return { anchor: sel.anchor, paths };
    }
  }
  if (m.toggle) {
    const paths = new Set(sel.paths);
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    return { anchor: path, paths };
  }
  return { anchor: path, paths: new Set([path]) };
}

/** Drops selected paths that are inside another selected folder (a move/delete of the folder covers them). */
export function topLevel(paths: Iterable<string>): string[] {
  const all = [...paths].sort();
  const out: string[] = [];
  for (const p of all) {
    const last = out[out.length - 1];
    if (last !== undefined && p.startsWith(`${last}/`)) continue;
    out.push(p);
  }
  return out;
}

/** True if `src` may be dropped onto folder `dest`: not onto itself, a descendant, or its current parent. */
export function canDrop(src: string, dest: string): boolean {
  if (src === dest || dest.startsWith(`${src}/`)) return false;
  const parent = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
  return parent !== dest;
}

// ---- state transitions (immutable at the top level; DirState maps are copied on write) ------

export function withExpanded(s: TreeState, path: string, open: boolean): TreeState {
  const expanded = new Set(s.expanded);
  if (open) expanded.add(path);
  else expanded.delete(path);
  return { ...s, expanded };
}

export function withPage(s: TreeState, dir: string, page: number, entries: Entry[], total: number): TreeState {
  const old = s.dirs.get(dir) ?? newDir(total);
  const pages = new Map(old.pages);
  pages.set(page, entries);
  const loading = new Set(old.loading);
  loading.delete(page);
  const dirs = new Map(s.dirs);
  dirs.set(dir, { total, pages, loading, error: null });
  return { ...s, dirs };
}

export function withLoading(s: TreeState, dir: string, page: number): TreeState {
  const old = s.dirs.get(dir) ?? newDir(0);
  const loading = new Set(old.loading).add(page);
  const dirs = new Map(s.dirs);
  dirs.set(dir, { ...old, loading });
  return { ...s, dirs };
}

export function withError(s: TreeState, dir: string, page: number, message: string): TreeState {
  const old = s.dirs.get(dir) ?? newDir(0);
  const loading = new Set(old.loading);
  loading.delete(page);
  const dirs = new Map(s.dirs);
  dirs.set(dir, { ...old, loading, error: message });
  return { ...s, dirs };
}

/** Forget a folder's listing (it changed on disk); expanded state is kept so it reloads. */
export function invalidate(s: TreeState, dir: string): TreeState {
  if (!s.dirs.has(dir)) return s;
  const dirs = new Map(s.dirs);
  dirs.delete(dir);
  return { ...s, dirs };
}

/** Drop listings for folders that are neither expanded nor the root (bounded memory on long sessions). */
export function pruneCollapsed(s: TreeState, keep: ReadonlySet<string> = new Set()): TreeState {
  const dirs = new Map<string, DirState>();
  for (const [k, v] of s.dirs) if (s.expanded.has(k) || keep.has(k)) dirs.set(k, v);
  return dirs.size === s.dirs.size ? s : { ...s, dirs };
}
