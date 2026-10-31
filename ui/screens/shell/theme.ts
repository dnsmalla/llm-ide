// Theme choice persistence (per-viewer convenience: the webview's own storage, which lives in the
// app data folder; a failure only means the choice lasts for this session).
import { DEFAULT_THEME_ID, applyTheme, isThemeId, type ThemeId } from "@llmide/ui-kit";

export { THEMES, applyTheme, type ThemeId } from "@llmide/ui-kit";

const KEY = "llmide.theme";
const LEGACY_KEY = "llmide.poc.theme";

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const defaultStorage = (): StorageLike | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function readStoredTheme(storage: StorageLike | null = defaultStorage()): ThemeId {
  try {
    for (const k of [KEY, LEGACY_KEY]) {
      const v = storage?.getItem(k) ?? null;
      if (isThemeId(v)) return v;
    }
  } catch {
    // storage unavailable: default
  }
  return DEFAULT_THEME_ID;
}

export function storeTheme(id: ThemeId, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(KEY, id);
  } catch {
    // storage unavailable: session only
  }
}

/** Apply a theme to the document (data-theme + color-scheme). */
export function showTheme(id: ThemeId): void {
  applyTheme(id);
}
