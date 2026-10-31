// GENERATED - do not edit.
// Source: schema/design/tokens.json
// Regenerate with `node scripts/gen-design-tokens.mjs` (or `make design-tokens`).

export const THEMES = [
  { id: "dark", label: "Dark", isDark: true },
  { id: "light", label: "Light", isDark: false },
  { id: "midnight", label: "Midnight", isDark: true },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
