// The Explorer's docked Code Assistant: open/closed and width, remembered per viewer (webview localStorage, one global
// entry, like the Mac's persisted panel width). A convenience only: storage is untrusted input (any script in the
// origin can write it) and may be unavailable, so every read validates and every access is guarded. Pure.
import type { KV } from "./session";

export const DOCK_KEY = "llmide.explorer.chatdock";
export const DOCK_MIN = 300;
export const DOCK_MAX = 720;
export const DOCK_DEFAULT = 400;
/** The editor always keeps at least this much; below it the dock is hidden instead of squeezing the editor. */
export const MIN_CENTER = 320;

export interface DockPrefs {
  open: boolean;
  width: number;
}

export const DEFAULT_DOCK: DockPrefs = Object.freeze({ open: true, width: DOCK_DEFAULT });

/** A width inside [DOCK_MIN, DOCK_MAX] that leaves the editor MIN_CENTER next to `reserved` (the tree). Junk -> the default. */
export function clampDockWidth(w: unknown, viewport: number, reserved: number): number {
  const wanted = typeof w === "number" && Number.isFinite(w) ? w : DOCK_DEFAULT;
  const room = Number.isFinite(viewport) && Number.isFinite(reserved) ? viewport - reserved - MIN_CENTER : DOCK_MAX;
  const max = Math.max(DOCK_MIN, Math.min(DOCK_MAX, room));
  return Math.round(Math.min(Math.max(wanted, DOCK_MIN), max));
}

/** Is there room for the dock at all (tree + dock minimum + editor minimum)? */
export function dockFits(viewport: number, reserved: number): boolean {
  return Number.isFinite(viewport) && Number.isFinite(reserved) && viewport - reserved >= DOCK_MIN + MIN_CENTER;
}

/** Decode the stored entry; anything malformed reads as the default (never throws). */
export function parseDockPrefs(raw: unknown): DockPrefs {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 200) return DEFAULT_DOCK;
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return DEFAULT_DOCK;
    const r = o as Record<string, unknown>;
    const open = typeof r.open === "boolean" ? r.open : DEFAULT_DOCK.open;
    const width = typeof r.width === "number" && Number.isFinite(r.width) ? Math.min(Math.max(Math.round(r.width), DOCK_MIN), DOCK_MAX) : DEFAULT_DOCK.width;
    return { open, width };
  } catch {
    return DEFAULT_DOCK;
  }
}

export function readDockPrefs(kv: KV | null): DockPrefs {
  if (!kv) return DEFAULT_DOCK;
  try {
    return parseDockPrefs(kv.getItem(DOCK_KEY));
  } catch {
    return DEFAULT_DOCK;
  }
}

export function writeDockPrefs(kv: KV | null, p: DockPrefs): void {
  if (!kv) return;
  try {
    kv.setItem(DOCK_KEY, JSON.stringify({ open: p.open === true, width: clampDockWidth(p.width, Number.POSITIVE_INFINITY, 0) }));
  } catch {
    /* storage unavailable or full: the choice applies for this session only */
  }
}
