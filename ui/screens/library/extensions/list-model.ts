// Row model of the Installed list: kind headers and items flattened into one windowed list. Pure, so the
// windowing and keyboard stepping are tested without a DOM. Heights are fixed per row type; offsets are
// prefix sums, so a thousand installed items cost one array and a binary search per scroll.
import type { InstalledItem } from "./decoders.ts";
import { groupItems, kindTitle } from "./presentation.ts";

export type ListRow = { kind: "header"; label: string; count: number } | { kind: "item"; item: InstalledItem };

export const ITEM_ROW_HEIGHT = 60;
export const HEADER_ROW_HEIGHT = 28;

export function flattenGroups(items: readonly InstalledItem[]): ListRow[] {
  const rows: ListRow[] = [];
  for (const g of groupItems(items)) {
    rows.push({ kind: "header", label: kindTitle(g.kind), count: g.items.length });
    for (const item of g.items) rows.push({ kind: "item", item });
  }
  return rows;
}

export const heightOf = (r: ListRow | undefined): number => (r?.kind === "header" ? HEADER_ROW_HEIGHT : ITEM_ROW_HEIGHT);

export function offsetsOf(rows: readonly ListRow[]): Float64Array {
  const o = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i++) o[i + 1] = o[i]! + heightOf(rows[i]);
  return o;
}

/** First row whose bottom edge is below `y`. */
export function rowAtOffset(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(lo, Math.max(0, offsets.length - 2));
}

/** Rows to mount for a scroll position (with overscan), and the spacer heights above and below. */
export function visibleRows(offsets: Float64Array, scrollTop: number, viewport: number, overscan = 6): { start: number; end: number; padTop: number; padBottom: number; total: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 };
  const first = rowAtOffset(offsets, Math.max(0, scrollTop));
  const last = rowAtOffset(offsets, Math.max(0, scrollTop) + Math.max(0, viewport));
  const start = Math.max(0, first - overscan);
  const end = Math.min(n, last + 1 + overscan);
  return { start, end, padTop: offsets[start]!, padBottom: offsets[n]! - offsets[end]!, total: offsets[n]! };
}

/** Arrow-key stepping over item rows only (headers are skipped). Returns the new selected id. */
export function stepItem(rows: readonly ListRow[], selectedId: string | null, delta: 1 | -1 | "first" | "last"): string | null {
  const ids: string[] = [];
  for (const r of rows) if (r.kind === "item") ids.push(r.item.id);
  if (ids.length === 0) return null;
  if (delta === "first") return ids[0]!;
  if (delta === "last") return ids[ids.length - 1]!;
  const i = selectedId === null ? -1 : ids.indexOf(selectedId);
  if (i < 0) return delta === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(ids.length - 1, Math.max(0, i + delta))]!;
}

/** Index of an item's row (to scroll a keyboard selection into view), or -1. */
export function rowIndexOf(rows: readonly ListRow[], id: string | null): number {
  return id === null ? -1 : rows.findIndex((r) => r.kind === "item" && r.item.id === id);
}

/** Browse list: fixed row height, plain windowing. */
export const BROWSE_ROW_HEIGHT = 84;
export function browseWindow(total: number, scrollTop: number, viewport: number, overscan = 6): { start: number; end: number; padTop: number; padBottom: number } {
  const first = Math.floor(Math.max(0, scrollTop) / BROWSE_ROW_HEIGHT);
  const vis = Math.ceil(Math.max(0, viewport) / BROWSE_ROW_HEIGHT);
  const start = Math.min(total, Math.max(0, first - overscan));
  const end = Math.max(start, Math.min(total, first + vis + overscan));
  return { start, end, padTop: start * BROWSE_ROW_HEIGHT, padBottom: (total - end) * BROWSE_ROW_HEIGHT };
}

/** Diff file lists: fixed small rows. */
export const FILE_ROW_HEIGHT = 24;
export function fileWindow(total: number, scrollTop: number, viewport: number): { start: number; end: number; padTop: number; padBottom: number } {
  const first = Math.floor(Math.max(0, scrollTop) / FILE_ROW_HEIGHT);
  const vis = Math.ceil(Math.max(0, viewport) / FILE_ROW_HEIGHT);
  const start = Math.min(total, Math.max(0, first - 4));
  const end = Math.max(start, Math.min(total, first + vis + 4));
  return { start, end, padTop: start * FILE_ROW_HEIGHT, padBottom: (total - end) * FILE_ROW_HEIGHT };
}
