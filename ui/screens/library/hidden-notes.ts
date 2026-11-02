// "Remove from List" for notes. The Mac only hides the row in its own index database and never touches the
// note file; the desktop keeps the same promise with a per-project hidden set of note paths in browser
// storage (a per-viewer convenience, like the Library's other prefs). Hiding never deletes anything: the
// file stays, and "Show hidden" / "Unhide" bring a note back.

export const HIDDEN_KEY = "llmide.library.hidden";
/** Per project folder. Past this, further hides are refused and counted, never dropped silently. */
export const HIDDEN_LIMIT = 10_000;
const MAX_REL = 1024;

export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Hides `rels` on top of `current`. `refused` counts the new paths that did not fit under the bound. */
export function hideRels(current: ReadonlySet<string>, rels: readonly string[]): { hidden: Set<string>; refused: number } {
  const hidden = new Set(current);
  let refused = 0;
  for (const rel of rels) {
    if (hidden.has(rel)) continue;
    if (hidden.size >= HIDDEN_LIMIT) refused += 1;
    else hidden.add(rel);
  }
  return { hidden, refused };
}

export function unhideRels(current: ReadonlySet<string>, rels: readonly string[]): Set<string> {
  const next = new Set(current);
  for (const rel of rels) next.delete(rel);
  return next;
}

/** Keeps only the paths the folder still has (a rescan that completed). */
export function pruneHidden(current: ReadonlySet<string>, present: (rel: string) => boolean): Set<string> {
  return new Set([...current].filter(present));
}

/** A note is shown unless it is hidden and the "Show hidden" toggle is off. */
export function isVisible(rel: string, hidden: ReadonlySet<string>, showHidden: boolean): boolean {
  return showHidden || !hidden.has(rel);
}

/** Reads this folder's hidden paths. Anything unexpected (bad JSON, wrong shape, control characters) is dropped. */
export function loadHidden(storage: KeyValue | null, root: string): Set<string> {
  const out = new Set<string>();
  try {
    const all = JSON.parse(storage?.getItem(HIDDEN_KEY) ?? "{}") as unknown;
    const list = typeof all === "object" && all !== null && !Array.isArray(all) ? (all as Record<string, unknown>)[root] : undefined;
    if (!Array.isArray(list)) return out;
    for (const v of list) {
      if (typeof v !== "string" || v === "" || v.length > MAX_REL || /[\u0000-\u001f]/.test(v)) continue;
      out.add(v);
      if (out.size >= HIDDEN_LIMIT) break;
    }
  } catch {
    /* unreadable: nothing hidden this session */
  }
  return out;
}

/** Writes this folder's hidden paths; other folders' entries are kept. Storage may be absent or full. */
export function saveHidden(storage: KeyValue | null, root: string, hidden: ReadonlySet<string>): void {
  try {
    const all = JSON.parse(storage?.getItem(HIDDEN_KEY) ?? "{}") as Record<string, unknown>;
    const base = typeof all === "object" && all !== null && !Array.isArray(all) ? all : {};
    base[root] = [...hidden].slice(0, HIDDEN_LIMIT);
    storage?.setItem(HIDDEN_KEY, JSON.stringify(base));
  } catch {
    /* session only */
  }
}

/** The notice after a hide that did not fit under the bound; null when everything was hidden. */
export function refusedMessage(refused: number): string | null {
  if (refused === 0) return null;
  const notes = refused === 1 ? "1 note was" : `${refused.toLocaleString("en-US")} notes were`;
  return `The hidden list is full (${HIDDEN_LIMIT.toLocaleString("en-US")} notes). ${notes} not hidden. Unhide some first.`;
}
