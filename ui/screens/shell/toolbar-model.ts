// The top toolbar's pure model (Mac `AppShell.shellToolbar` + `ToolbarToolButton`): which sections it lists and in
// what order, the roving-focus rules, and the overflow partition for narrow windows. No React, no DOM: tested with node.
import { SECTIONS, devToolsEnabled, type SectionDef, type SectionId } from "./sections";

/**
 * The toolbar sections in the Mac's `ShellSection.toolbarOrder` (Live is only shown while a session records and
 * the desktop has no live capture yet, so it is absent). `tests/toolbar.test.mjs` parses the Swift source and fails
 * when this list drifts from it.
 */
export const TOOLBAR_IDS: readonly SectionId[] = ["explorer", "graph", "autotasks", "conflicts", "issues", "gantt", "loop", "docgen", "visual", "library"];

/** Mac `ShellSection` case name -> desktop section id. `null` = the Mac item has no desktop counterpart (yet). */
export const MAC_CASE_TO_ID: Readonly<Record<string, SectionId | null>> = {
  explorer: "explorer",
  codeGraph: "graph",
  autoCode: "autotasks",
  conflicts: "conflicts",
  issues: "issues",
  gantt: "gantt",
  loopEngine: "loop",
  docGen: "docgen",
  visual: "visual",
  library: "library",
  live: null,
};

const BY_ID = new Map<string, SectionDef>(SECTIONS.map((s) => [s.id, s]));

/** The sections the toolbar lists now: the Mac list, plus the developer-only Spike item when developer tools are on. */
export function toolbarSections(devTools: boolean = devToolsEnabled()): SectionDef[] {
  const out: SectionDef[] = [];
  for (const id of TOOLBAR_IDS) {
    const d = BY_ID.get(id);
    if (d) out.push(d);
  }
  const spike = BY_ID.get("spike");
  if (devTools && spike) out.push(spike);
  return out;
}

// ---- roving focus ---------------------------------------------------------------------------------------------

/** Arrow/Home/End target among `count` focusable items (APG toolbar: horizontal, wraps; focus moves, nothing activates). */
export function toolbarKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * The one tab stop of the toolbar: the active item when it is a focusable (enabled, visible) toolbar item, otherwise
 * the first focusable item, otherwise null (nothing to focus).
 */
export function rovingStop(focusable: readonly string[], active: string | null): string | null {
  if (active !== null && focusable.includes(active)) return active;
  return focusable[0] ?? null;
}

// ---- overflow -------------------------------------------------------------------------------------------------

export interface Partition {
  /** Indices (into the input order) shown in the bar. */
  visible: number[];
  /** Indices collapsed into the More menu. */
  overflow: number[];
}

/** Rough width of an item before it was measured (icon + label + padding), so the first layout is close. */
export function estimateWidth(label: string): number {
  return 38 + Math.max(0, label.length) * 7;
}

/**
 * Which items fit. All visible when everything fits; otherwise the longest prefix that fits next to the More button
 * (`moreWidth`), with the `pinned` item (the active one) always kept visible by giving up items from the prefix's end.
 * Non-finite or negative inputs degrade to "everything in the menu except the pinned item", never to a throw.
 */
export function partitionToolbar(widths: readonly number[], available: number, moreWidth: number, gap: number, pinned: number = -1): Partition {
  const n = widths.length;
  const w = (i: number) => (Number.isFinite(widths[i]) && widths[i]! > 0 ? widths[i]! : 0);
  const g = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const room = Number.isFinite(available) ? available : 0;
  const more = Number.isFinite(moreWidth) && moreWidth > 0 ? moreWidth : 0;
  const all = Array.from({ length: n }, (_, i) => i);
  let total = 0;
  for (let i = 0; i < n; i++) total += w(i) + (i > 0 ? g : 0);
  if (total <= room) return { visible: all, overflow: [] };

  const budget = room - more - g;
  const keep: number[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const next = used + (keep.length ? g : 0) + w(i);
    if (next > budget) break;
    keep.push(i);
    used = next;
  }
  const hasPin = pinned >= 0 && pinned < n;
  if (hasPin && !keep.includes(pinned)) {
    const width = (list: number[]) => list.reduce((a, i, k) => a + w(i) + (k ? g : 0), 0);
    while (keep.length && width([...keep, pinned]) > budget) keep.pop();
    keep.push(pinned);
    keep.sort((a, b) => a - b);
  }
  const shown = new Set(keep);
  return { visible: keep, overflow: all.filter((i) => !shown.has(i)) };
}

export function samePartition(a: Partition, b: Partition): boolean {
  return a.overflow.length === b.overflow.length && a.overflow.every((v, i) => v === b.overflow[i]);
}
