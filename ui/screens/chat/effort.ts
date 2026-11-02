// Reasoning effort, the desktop's port of the Mac's "Effort" section (EffortChoice + CodeAssistantModelState). The
// levels are the SDK's own per Claude model (`effortLevels` on each row of the model listing); a catalog or custom
// provider offers none. The pick is one app-wide choice, kept when a model does not offer it (a switch back restores it).
import type { ModelGroup } from "./route";

export const EFFORT_AUTO = "auto";
export const EFFORT_KEY = "chat.effort";

export function effortLabel(level: string): string {
  return level ? level[0]!.toUpperCase() + level.slice(1) : level;
}

/** What a turn uses: the stored pick when the model offers it, else Auto. The stored pick itself is not changed. */
export function effectiveEffort(stored: string, levels: readonly string[]): string {
  return levels.includes(stored) ? stored : EFFORT_AUTO;
}

/** The body's `effort`: only a level the user chose and the model offers; nothing otherwise (the core picks). */
export function turnEffort(stored: string, levels: readonly string[]): string | undefined {
  const e = effectiveEffort(stored, levels);
  return e === EFFORT_AUTO ? undefined : e;
}

// Mirrors AIModel.baseId (Mac) and the core's baseId: lowercase, no trailing "[1m]", no trailing "-YYYYMMDD".
function baseId(id: string): string {
  return id.toLowerCase().replace(/\[1m\]$/, "").replace(/-\d{8}$/, "");
}
// Mirrors ModelDisplayName.normalizedId (Mac): baseId, no "-latest" alias, dots as dashes.
function normalizedId(id: string): string {
  return baseId(id.trim()).replace(/-latest$/, "").replace(/\./g, "-");
}

/**
 * The effort levels of the model a turn would run on. No model chosen = the Claude default (the listing's first row).
 * Only Claude offers effort: a catalog or custom provider gets none.
 */
export function effortLevelsFor(groups: readonly ModelGroup[], provider: string | null | undefined, model: string | null | undefined): string[] {
  if (provider && provider !== "anthropic") return [];
  const rows = groups.find((g) => !g.catalog)?.models ?? [];
  if (!model) return [...(rows[0]?.effortLevels ?? [])];
  const exact = rows.find((r) => r.model === model);
  const same = exact ?? rows.find((r) => baseId(r.model) === baseId(model))
    ?? rows.find((r) => normalizedId(r.model) === normalizedId(model));
  return [...(same?.effortLevels ?? [])];
}

/** Minimal storage shape, so a test (or a webview with no storage) passes its own. */
type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** The remembered pick. A storage that throws or is missing reads as Auto. */
export function loadEffortPick(storage: Store | undefined = defaultStore()): string {
  try { return storage?.getItem(EFFORT_KEY) || EFFORT_AUTO; } catch { return EFFORT_AUTO; }
}
/** Best effort: a refused write only means the pick is not remembered next launch. */
export function saveEffortPick(level: string, storage: Store | undefined = defaultStore()): void {
  try { storage?.setItem(EFFORT_KEY, level); } catch { /* not remembered */ }
}

/**
 * The one app-wide pick, shared by every Chat surface in this window (docked and section), like the Mac's @AppStorage:
 * a pick in one shows in the other at once. Read from storage once, on first use.
 */
export function createEffortStore(storage?: Store) {
  let value: string | null = null;
  const listeners = new Set<() => void>();
  // An undefined `storage` takes the helpers' default (window localStorage).
  const get = () => (value ??= loadEffortPick(storage));
  return {
    get,
    set(level: string) {
      if (get() === level) return;
      value = level;
      saveEffortPick(level, storage);
      for (const l of [...listeners]) l();
    },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}
export const effortStore = createEffortStore();
