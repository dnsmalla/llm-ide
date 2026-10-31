// Search over node titles and paths. A linear scan over 50k short strings is a few milliseconds, so there
// is no index to build or keep in memory. Results are index lists (typed), ranked: exact title, title
// prefix, title contains, path contains; each group in node order. The list view windows them.
import type { GraphModel } from "./model.ts";

export const MAX_QUERY = 200;
export const MAX_RESULTS = 5000;

export function searchNodes(model: GraphModel, query: string, limit = MAX_RESULTS): Uint32Array {
  const q = query.trim().slice(0, MAX_QUERY).toLowerCase();
  if (q.length === 0) return new Uint32Array(0);
  const buckets: number[][] = [[], [], [], []];
  let total = 0;
  for (let i = 0; i < model.n && total < limit * 4; i++) {
    const t = model.titles[i].toLowerCase();
    let b = -1;
    if (t === q) b = 0;
    else if (t.startsWith(q)) b = 1;
    else if (t.includes(q)) b = 2;
    else {
      const p = model.paths[i];
      if (p !== null && p.toLowerCase().includes(q)) b = 3;
    }
    if (b >= 0) {
      buckets[b].push(i);
      total++;
    }
  }
  const out = new Uint32Array(Math.min(limit, total));
  let k = 0;
  for (const bucket of buckets) for (const i of bucket) if (k < out.length) out[k++] = i;
  return out;
}

export interface FixedWindow {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** Rows to render for a fixed-height virtual list. */
export function fixedWindow(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 6): FixedWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const last = Math.min(count - 1, Math.floor((Math.max(0, scrollTop) + Math.max(viewport, 1)) / rowHeight));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + 1 + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}
