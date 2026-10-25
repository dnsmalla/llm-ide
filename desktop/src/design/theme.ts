// Theme ids mirror Theme.swift (`Theme.all`): Dark / Light / Midnight.
export const THEMES = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "midnight", label: "Midnight" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "llmide.poc.theme";
export const DEFAULT_THEME: ThemeId = "dark";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

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

/** Sets the `data-theme` attribute that selects the generated token block. */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  root.dataset.theme = id;
  root.style.colorScheme = id === "light" ? "light" : "dark";
}
