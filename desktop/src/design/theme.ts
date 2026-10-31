// Theme ids and `applyTheme` come from @llmide/ui-kit (generated from schema/design/tokens.json).
// Only the desktop-specific persistence lives here.
import { DEFAULT_THEME_ID, isThemeId, type ThemeId } from "@llmide/ui-kit";

export { THEMES, applyTheme, isThemeId, type ThemeId } from "@llmide/ui-kit";

const STORAGE_KEY = "llmide.poc.theme";
export const DEFAULT_THEME: ThemeId = DEFAULT_THEME_ID;

/** Persisted choice; any storage failure (private window, blocked) falls back to the default. */
export function readStoredTheme(): ThemeId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (isThemeId(v)) return v;
  } catch {
    // storage unavailable: use the default
  }
  return DEFAULT_THEME;
}

export function storeTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable: the choice applies for this session only
  }
}
