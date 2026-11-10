// Add any missing built-in loops to an existing Loop file and persist them immediately, so scheduled runs never
// see an unsaved buffer. A failed write keeps the in-memory store for the normal Save retry.
import type { LoopDefaults } from "../../shell/host-prefs.ts";
import { saveLoops, type LoopFs, type LoopLoad } from "./store.ts";
import { ensureDefaultLoops } from "./templates.ts";

export interface EnsuredDefaults {
  load: LoopLoad;
  added: string[];
  /** True when the added loops are now in system/loop.json. */
  saved: boolean;
  error: string | null;
}

export async function persistEnsuredDefaults(fs: LoopFs, load: LoopLoad, testCommand: string | null, defaults?: LoopDefaults): Promise<EnsuredDefaults> {
  if (load.kind !== "ok") return { load, added: [], saved: false, error: null };
  const ensured = ensureDefaultLoops(load.store, testCommand, defaults);
  if (ensured.added.length === 0 && ensured.upgraded.length === 0) return { load, added: [], saved: false, error: null };
  try {
    const r = await saveLoops(fs, ensured.store, load.hash);
    return { load: { kind: "ok", store: ensured.store, hash: r.hash }, added: ensured.added, saved: true, error: null };
  } catch (e) {
    return { load: { kind: "ok", store: ensured.store, hash: load.hash }, added: ensured.added, saved: false, error: e instanceof Error ? e.message : "The Loop file could not be saved." };
  }
}
