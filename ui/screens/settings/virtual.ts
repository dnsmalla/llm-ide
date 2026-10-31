// Windowing maths for long lists (1,000+ connections or models). Pure, so it is tested
// without a DOM; VirtualList.tsx renders only the rows this returns.

export interface WindowInput {
  total: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
}
export interface WindowRange {
  start: number;
  /** Exclusive. */
  end: number;
  /** Space above the first rendered row, and below the last, in px. */
  padTop: number;
  padBottom: number;
  totalHeight: number;
}

export function windowRange(i: WindowInput): WindowRange {
  const overscan = i.overscan ?? 6;
  const total = Math.max(0, Math.floor(i.total));
  const rowHeight = Math.max(1, i.rowHeight);
  const first = Math.floor(Math.max(0, i.scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, i.viewportHeight) / rowHeight);
  const start = Math.min(total, Math.max(0, first - overscan));
  const end = Math.min(total, first + visible + overscan);
  const safeEnd = Math.max(start, end);
  return {
    start,
    end: safeEnd,
    padTop: start * rowHeight,
    padBottom: (total - safeEnd) * rowHeight,
    totalHeight: total * rowHeight,
  };
}

/** Case-insensitive substring filter that keeps the original order. Empty query returns the input. */
export function filterBy<T>(items: readonly T[], query: string, text: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice();
  return items.filter((t) => text(t).toLowerCase().includes(q));
}
