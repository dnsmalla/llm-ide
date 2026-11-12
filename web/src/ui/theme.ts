// Theme preference: "system" follows prefers-color-scheme (light or dark); otherwise one of the kit's themes. The choice is
// kept in localStorage (every access guarded: private windows and blocked storage throw). The kit's applyTheme sets
// data-theme + color-scheme; this adds the preference, the persistence and the browser-chrome colour.
import { useSyncExternalStore } from "react";
import { THEMES, applyTheme, isThemeId, type ThemeId } from "@llmide/ui-kit";

export type ThemePref = "system" | ThemeId;
export const THEME_KEY = "llmide-web-theme";
export const THEME_OPTIONS: readonly { value: ThemePref; label: string }[] = [{ value: "system", label: "System" }, ...THEMES.map((t) => ({ value: t.id as ThemePref, label: t.label }))];
// Browser chrome (PWA status bar / address bar): the theme's body colour, as hex (tokens.json: rgb % of --tok-color-body).
const CHROME: Record<ThemeId, string> = { dark: "#12141c", light: "#f4f5f7", midnight: "#0f1221" };

export function parsePref(v: unknown): ThemePref { return v === "system" || isThemeId(v) ? v : "system"; }
export function readThemePref(): ThemePref {
  try { return parsePref(globalThis.localStorage?.getItem(THEME_KEY)); } catch { return "system"; }
}
function writeThemePref(p: ThemePref) { try { globalThis.localStorage?.setItem(THEME_KEY, p); } catch { /* blocked storage: the choice lasts this page only */ } }
export function systemTheme(): ThemeId {
  try { return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"; } catch { return "dark"; }
}
export const resolveTheme = (p: ThemePref, sys: ThemeId = systemTheme()): ThemeId => (p === "system" ? sys : p);

let pref: ThemePref = "system";
const subs = new Set<() => void>();
function paint() {
  if (typeof document === "undefined") return;
  const id = resolveTheme(pref);
  applyTheme(id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", CHROME[id]);
}
export function setThemePref(p: ThemePref) { pref = p; writeThemePref(p); paint(); for (const fn of subs) fn(); }
/** Call once before the first render. Returns a cleanup that stops following the OS. */
export function initTheme(): () => void {
  pref = readThemePref();
  paint();
  const mq = typeof globalThis.matchMedia === "function" ? globalThis.matchMedia("(prefers-color-scheme: light)") : null;
  const onChange = () => { if (pref === "system") paint(); };
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
}
/** For the dev gallery: render under a theme without touching the stored preference. */
export function previewTheme(id: ThemeId) { if (typeof document !== "undefined") applyTheme(id); }

const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };
export function useThemePref(): readonly [ThemePref, (p: ThemePref) => void] {
  const p = useSyncExternalStore(subscribe, () => pref, () => "system" as ThemePref);
  return [p, setThemePref];
}
