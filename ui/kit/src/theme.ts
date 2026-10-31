// Theme ids come from tokens.json (via themes.generated.ts), never typed by hand.
import { THEMES, type ThemeId } from "./themes.generated";

export { THEMES };
export type { ThemeId };

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

/** Sets `data-theme` (selects the generated token block) and the matching `color-scheme`. */
export function applyTheme(id: ThemeId, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = id;
  root.style.colorScheme = THEMES.find((t) => t.id === id)?.isDark === false ? "light" : "dark";
}

/** The theme `:root` paints before any `data-theme` is set: the first theme in tokens.json. */
export const DEFAULT_THEME_ID: ThemeId = THEMES[0].id;
