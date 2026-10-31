// Windowing math for the virtualised lists (messages with measured heights, sessions with fixed
// heights). Pure: offsets are a prefix-sum array, the visible range is a binary search.

/** Prefix sums: offsets[i] is the top of item i; offsets[n] is the total height. Unmeasured items use `estimate`. */
export function buildOffsets(heights: ArrayLike<number | undefined>, count: number, estimate: number): Float64Array {
  const offsets = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) {
    const h = heights[i];
    offsets[i + 1] = offsets[i] + (typeof h === "number" && h > 0 ? h : estimate);
  }
  return offsets;
}

export interface WindowRange {
  /** First item to render (inclusive), overscan included. */
  start: number;
  /** One past the last item to render, overscan included. */
  end: number;
  /** Spacer heights above the first and below the last rendered item. */
  padTop: number;
  padBottom: number;
  total: number;
}

/** Largest i with offsets[i] <= y (clamped to [0, count-1]). */
export function indexAt(offsets: Float64Array, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let lo = 0, hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** The slice of items to render for a viewport; overscan is in items on each side. */
export function computeWindow(offsets: Float64Array, scrollTop: number, viewport: number, overscan = 4): WindowRange {
  const count = offsets.length - 1;
  const total = offsets[count] ?? 0;
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, total: 0 };
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, total - viewport)));
  const first = indexAt(offsets, top);
  const last = indexAt(offsets, top + Math.max(viewport, 1));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + 1 + overscan);
  return { start, end, padTop: offsets[start], padBottom: total - offsets[end], total };
}

/** Scroll offset that keeps the same item at the same place after `added` items were prepended. */
export function prependScrollAdjust(newOffsets: Float64Array, added: number): number {
  return newOffsets[Math.min(added, newOffsets.length - 1)] ?? 0;
}

/** Within `slack` px of the bottom (the list should keep following a stream). */
export function isNearBottom(scrollTop: number, viewport: number, total: number, slack = 48): boolean {
  return total - (scrollTop + viewport) <= slack;
}

/** Near the top: load older items. */
export function shouldLoadOlder(scrollTop: number, slack = 160): boolean {
  return scrollTop <= slack;
}

/** Items per page when paging older messages. */
export const HISTORY_PAGE = 100;

// --- grouped session list -------------------------------------------------------------------

export type SessionRowModel<T> =
  | { kind: "header"; key: string; label: string }
  | { kind: "item"; key: string; item: T };

export const HEADER_HEIGHT = 28;
export const ITEM_HEIGHT = 44;

const DAY = 86_400_000;

/** Group label for a timestamp (ms): Today, Yesterday, Previous 7 days, Previous 30 days, then month. */
export function groupLabel(updatedMs: number, nowMs: number): string {
  const startOfToday = new Date(nowMs); startOfToday.setHours(0, 0, 0, 0);
  const t = startOfToday.getTime();
  if (updatedMs >= t) return "Today";
  if (updatedMs >= t - DAY) return "Yesterday";
  if (updatedMs >= t - 7 * DAY) return "Previous 7 days";
  if (updatedMs >= t - 30 * DAY) return "Previous 30 days";
  const d = new Date(updatedMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Flattens items (already sorted newest first) into header and item rows. */
export function groupRows<T>(items: readonly T[], updatedMs: (t: T) => number, key: (t: T) => string, nowMs: number): SessionRowModel<T>[] {
  const rows: SessionRowModel<T>[] = [];
  let current = "";
  for (const item of items) {
    const label = groupLabel(updatedMs(item), nowMs);
    if (label !== current) { rows.push({ kind: "header", key: `h:${label}`, label }); current = label; }
    rows.push({ kind: "item", key: key(item), item });
  }
  return rows;
}

export function rowHeights<T>(rows: readonly SessionRowModel<T>[]): number[] {
  return rows.map((r) => (r.kind === "header" ? HEADER_HEIGHT : ITEM_HEIGHT));
}
