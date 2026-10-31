// Per-project session (open tabs, expanded folders, panel width) in webview localStorage.
// A per-viewer convenience only: never durable state, content is never stored, and every read and
// write is guarded (private windows and cleared site data must not break the screen).
import type { SessionTabs } from "./tabs-model";

export interface ExplorerSession {
  tabs: SessionTabs | null;
  expanded: string[];
  treeWidth: number | null;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** FNV-1a over the project root: a short stable key (the root path itself is not put in the key). */
export function projectKey(root: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < root.length; i++) {
    h ^= root.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `llmide.explorer.session.${h.toString(16).padStart(8, "0")}`;
}

const MAX_EXPANDED = 500;

export function loadSession(kv: KV | null, root: string): ExplorerSession {
  const empty: ExplorerSession = { tabs: null, expanded: [], treeWidth: null };
  if (!kv) return empty;
  try {
    const raw = kv.getItem(projectKey(root));
    if (!raw || raw.length > 512 * 1024) return empty;
    const o = JSON.parse(raw) as Partial<ExplorerSession>;
    const expanded = Array.isArray(o.expanded) ? o.expanded.filter((p): p is string => typeof p === "string" && p.length < 4096 && !p.includes("\0") && !p.startsWith("/") && !p.split("/").includes("..")).slice(0, MAX_EXPANDED) : [];
    const w = typeof o.treeWidth === "number" && Number.isFinite(o.treeWidth) ? Math.min(800, Math.max(140, o.treeWidth)) : null;
    return { tabs: o.tabs && typeof o.tabs === "object" ? (o.tabs as SessionTabs) : null, expanded, treeWidth: w };
  } catch {
    return empty;
  }
}

export function saveSession(kv: KV | null, root: string, s: ExplorerSession): void {
  if (!kv) return;
  try {
    kv.setItem(projectKey(root), JSON.stringify({ ...s, expanded: s.expanded.slice(0, MAX_EXPANDED) }));
  } catch {
    /* storage unavailable or full: the session is a convenience */
  }
}

export function defaultKv(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
