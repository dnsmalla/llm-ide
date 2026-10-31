// Windowing maths for the virtualised note list and long transcripts. Pure, so it is tested
// without a DOM; the components render only the rows this returns.

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
  /** Space above the first rendered row and below the last, in px. */
  padTop: number;
  padBottom: number;
  totalHeight: number;
}

export function windowRange(i: WindowInput): WindowRange {
  const fin = (n: number): number => (Number.isFinite(n) ? n : 0);
  const overscan = Math.max(0, fin(i.overscan ?? 8));
  const total = Math.max(0, Math.floor(fin(i.total)));
  const rowHeight = Math.max(1, fin(i.rowHeight));
  const first = Math.floor(Math.max(0, fin(i.scrollTop)) / rowHeight);
  const visible = Math.ceil(Math.max(0, fin(i.viewportHeight)) / rowHeight);
  const start = Math.min(total, Math.max(0, first - overscan));
  const end = Math.max(start, Math.min(total, first + visible + overscan));
  return { start, end, padTop: start * rowHeight, padBottom: (total - end) * rowHeight, totalHeight: total * rowHeight };
}

/** Scroll offset that brings row `index` fully into view with the least movement. */
export function scrollToReveal(index: number, rowHeight: number, scrollTop: number, viewportHeight: number): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}

/**
 * Progressive sections for a long document: how many sections to render for a scroll position.
 * `nearEndPx` before the end of what is rendered, one more section is added, up to `total`.
 */
export function sectionsToRender(opts: { rendered: number; total: number; scrollTop: number; viewportHeight: number; contentHeight: number; nearEndPx?: number }): number {
  const near = opts.nearEndPx ?? 800;
  if (opts.rendered >= opts.total) return opts.total;
  return opts.scrollTop + opts.viewportHeight + near >= opts.contentHeight ? opts.rendered + 1 : opts.rendered;
}

/** Splits `n` items into consecutive section ranges of at most `size` items. */
export function sectionRanges(n: number, size: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const sz = Math.max(1, Math.floor(size));
  for (let s = 0; s < n; s += sz) out.push({ start: s, end: Math.min(n, s + sz) });
  return out;
}
