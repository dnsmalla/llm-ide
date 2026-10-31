// Which OS the window chrome is for. The host reports it (`host_platform`, a fixed answer from the Rust side); a plain
// browser (vite dev) and the first paint use a navigator guess. Only macOS draws the traffic lights over our toolbar
// (tauri.conf `titleBarStyle: "Overlay"`); Windows and Linux keep their native title bar, so the toolbar needs no
// left padding there. Pure.

export type Platform = "macos" | "windows" | "linux" | "other";

const KNOWN: readonly Platform[] = ["macos", "windows", "linux", "other"];

/** The host's answer, or `other` for anything it should not have said. */
export function decodePlatform(raw: unknown): Platform {
  return typeof raw === "string" && (KNOWN as readonly string[]).includes(raw) ? (raw as Platform) : "other";
}

/** Navigator-based guess (first paint, browser fallback). */
export function guessPlatform(nav: { userAgent?: unknown; platform?: unknown } | null | undefined): Platform {
  const s = `${typeof nav?.platform === "string" ? nav.platform : ""} ${typeof nav?.userAgent === "string" ? nav.userAgent : ""}`;
  if (/Mac|iPhone|iPad/i.test(s)) return "macos";
  if (/Win/i.test(s)) return "windows";
  if (/Linux|X11|CrOS/i.test(s)) return "linux";
  return "other";
}

/** Left room (px) the toolbar keeps for the macOS traffic lights; none anywhere else or outside the desktop host. */
export const TRAFFIC_LIGHT_INSET_PX = 78;

/** True when the window draws OS controls over the toolbar row (macOS desktop app only). */
export function hasOverlayTitlebar(platform: Platform, hostAvailable: boolean): boolean {
  return hostAvailable && platform === "macos";
}
