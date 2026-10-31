// Multi-select model for the note list: pure, immutable, bounded.

export const SELECT_MAX = 50_000;

export interface Selection {
  readonly ids: ReadonlySet<string>;
  /** Last toggled path: the start of a shift-click range. */
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export function toggle(sel: Selection, rel: string): Selection {
  const ids = new Set(sel.ids);
  if (ids.has(rel)) ids.delete(rel);
  else if (ids.size < SELECT_MAX) ids.add(rel);
  return { ids, anchor: rel };
}

/** Adds every path between the anchor and `rel` (in list order). Without an anchor it just toggles `rel`. */
export function extendRange(sel: Selection, ordered: readonly string[], rel: string): Selection {
  if (sel.anchor === null) return toggle(sel, rel);
  const a = ordered.indexOf(sel.anchor);
  const b = ordered.indexOf(rel);
  if (a < 0 || b < 0) return toggle(sel, rel);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const ids = new Set(sel.ids);
  for (let i = lo; i <= hi && ids.size < SELECT_MAX; i++) ids.add(ordered[i]!);
  return { ids, anchor: rel };
}

export function selectAll(ordered: readonly string[]): Selection {
  return { ids: new Set(ordered.slice(0, SELECT_MAX)), anchor: null };
}

/** Drops paths that are no longer in the list (deleted, filtered out is NOT dropped: only gone ones). */
export function prune(sel: Selection, exists: (rel: string) => boolean): Selection {
  let changed = false;
  const ids = new Set<string>();
  for (const r of sel.ids) {
    if (exists(r)) ids.add(r);
    else changed = true;
  }
  return changed ? { ids, anchor: sel.anchor !== null && ids.has(sel.anchor) ? sel.anchor : null } : sel;
}
