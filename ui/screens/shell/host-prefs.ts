// Typed view of the host's `get_prefs` / `set_prefs` (desktop/src-tauri/src/prefs.rs). Pure: decode only.
// The host is the authority (strict schema, unknown keys refused); this side decodes defensively so a
// malformed answer reads as "unavailable" instead of showing invented values.

export type LtaModeValue = "off" | "shadow" | "on";

export interface HostPrefs {
  ltaMode: LtaModeValue;
  router: boolean;
  cap: boolean;
  compress: boolean;
  learn: boolean;
  terminal: boolean;
  theme: "dark" | "light" | "midnight";
}

export interface HostPrefsView {
  stored: HostPrefs;
  /** What this launch runs with. */
  launch: HostPrefs;
  restartNeeded: boolean;
  persisted: boolean;
}

export type HostPrefsPatch = Partial<HostPrefs>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function decodePrefs(raw: unknown): HostPrefs | null {
  if (!isObj(raw)) return null;
  const { ltaMode, router, cap, compress, learn, terminal, theme } = raw;
  if (ltaMode !== "off" && ltaMode !== "shadow" && ltaMode !== "on") return null;
  if (theme !== "dark" && theme !== "light" && theme !== "midnight") return null;
  for (const b of [router, cap, compress, learn, terminal]) if (typeof b !== "boolean") return null;
  return { ltaMode, router: router as boolean, cap: cap as boolean, compress: compress as boolean, learn: learn as boolean, terminal: terminal as boolean, theme };
}

export function decodePrefsView(raw: unknown): HostPrefsView | null {
  if (!isObj(raw)) return null;
  const stored = decodePrefs(raw.stored);
  const launch = decodePrefs(raw.launch);
  if (!stored || !launch) return null;
  return { stored, launch, restartNeeded: raw.restartNeeded === true, persisted: raw.persisted !== false };
}

/** The folder choice `pick_folder` returns: an opaque token and a display name, never a path. */
export function decodePickedChoice(raw: unknown): { token: string; name: string } | null {
  if (raw === null || !isObj(raw)) return null;
  return typeof raw.token === "string" && raw.token.length > 0 && typeof raw.name === "string" ? { token: raw.token, name: raw.name } : null;
}

/** The canonical path `pick_folder_redeem` returns: must look absolute, else it is refused. */
export function decodePickedFolder(raw: unknown): string | null {
  if (!isObj(raw) || typeof raw.path !== "string") return null;
  return raw.path.startsWith("/") || /^([A-Za-z]:[\\/]|\\\\)/.test(raw.path) ? raw.path : null;
}
