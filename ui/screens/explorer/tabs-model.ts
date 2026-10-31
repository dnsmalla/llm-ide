// Editor tab state machine. Pure; the screen dispatches actions and renders the result.
//
// Rules (Mac EditorTabBar + VS Code preview behaviour):
//  - Opening from the tree opens a PREVIEW tab (italic); at most one exists and the next open replaces
//    it. Editing, double click or pinning promotes it to a regular tab.
//  - Pinned tabs always sit left of unpinned ones, and cannot be closed by "close others / all".
//  - A dirty tab is never closed or replaced silently: `requestClose` answers `prompt`.
//  - Closing the active tab activates the most recently used remaining tab.

import { isSafeSessionPath } from "./session";

export interface Tab {
  /** Project-relative path; also the tab id. */
  id: string;
  preview: boolean;
  pinned: boolean;
  dirty: boolean;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** Most recently used first (includes only open tabs). */
  mru: string[];
}

export const MAX_TABS = 60;
export const emptyTabs: TabsState = { tabs: [], activeId: null, mru: [] };

export type TabsAction =
  | { type: "open"; path: string; preview: boolean }
  | { type: "activate"; id: string }
  | { type: "edit"; id: string; dirty: boolean }
  | { type: "promote"; id: string }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "move"; id: string; to: number }
  | { type: "close"; id: string }
  | { type: "closeOthers"; id: string }
  | { type: "closeAll" }
  | { type: "renamed"; from: string; to: string }
  | { type: "removed"; id: string };

const touch = (mru: string[], id: string) => [id, ...mru.filter((m) => m !== id)];

function normalise(tabs: Tab[]): Tab[] {
  // Pinned first, otherwise stable.
  return [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)];
}

function withoutTab(s: TabsState, id: string): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  const mru = s.mru.filter((m) => m !== id);
  let activeId = s.activeId;
  if (activeId === id) activeId = mru[0] ?? tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
  return { tabs, mru, activeId };
}

export function tabsReduce(s: TabsState, a: TabsAction): TabsState {
  switch (a.type) {
    case "open": {
      const existing = s.tabs.find((t) => t.id === a.path);
      if (existing) {
        // Re-opening as a regular tab promotes a preview.
        const tabs = !a.preview && existing.preview ? s.tabs.map((t) => (t.id === a.path ? { ...t, preview: false } : t)) : s.tabs;
        return { tabs, activeId: a.path, mru: touch(s.mru, a.path) };
      }
      let tabs = s.tabs;
      if (a.preview) {
        // Replace the existing clean preview tab in place.
        const i = tabs.findIndex((t) => t.preview && !t.dirty);
        if (i >= 0) {
          const old = tabs[i]!;
          tabs = tabs.map((t, k) => (k === i ? { id: a.path, preview: true, pinned: false, dirty: false } : t));
          return { tabs, activeId: a.path, mru: touch(s.mru.filter((m) => m !== old.id), a.path) };
        }
      }
      if (tabs.length >= MAX_TABS) {
        // Make room by dropping the least recently used clean, unpinned tab; if none, refuse to open.
        const victim = [...s.mru].reverse().find((id) => {
          const t = tabs.find((x) => x.id === id);
          return t && !t.dirty && !t.pinned;
        });
        if (!victim) return s;
        tabs = tabs.filter((t) => t.id !== victim);
        s = { ...s, mru: s.mru.filter((m) => m !== victim) };
      }
      return { tabs: [...tabs, { id: a.path, preview: a.preview, pinned: false, dirty: false }], activeId: a.path, mru: touch(s.mru, a.path) };
    }
    case "activate":
      return s.tabs.some((t) => t.id === a.id) ? { ...s, activeId: a.id, mru: touch(s.mru, a.id) } : s;
    case "edit":
      return { ...s, tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, dirty: a.dirty, preview: a.dirty ? false : t.preview } : t)) };
    case "promote":
      return { ...s, tabs: s.tabs.map((t) => (t.id === a.id ? { ...t, preview: false } : t)) };
    case "pin":
      return { ...s, tabs: normalise(s.tabs.map((t) => (t.id === a.id ? { ...t, pinned: a.pinned, preview: false } : t))) };
    case "move": {
      const from = s.tabs.findIndex((t) => t.id === a.id);
      if (from < 0) return s;
      const moving = s.tabs[from]!;
      const rest = s.tabs.filter((t) => t.id !== a.id);
      const pinnedCount = rest.filter((t) => t.pinned).length;
      // Stay inside the pinned / unpinned region.
      const lo = moving.pinned ? 0 : pinnedCount;
      const hi = moving.pinned ? pinnedCount : rest.length;
      const to = Math.max(lo, Math.min(hi, a.to));
      const tabs = [...rest.slice(0, to), moving, ...rest.slice(to)];
      return { ...s, tabs };
    }
    case "close":
      return withoutTab(s, a.id);
    case "closeOthers": {
      let next = s;
      for (const t of s.tabs) if (t.id !== a.id && !t.pinned && !t.dirty) next = withoutTab(next, t.id);
      return next.tabs.some((t) => t.id === a.id) ? { ...next, activeId: a.id, mru: touch(next.mru, a.id) } : next;
    }
    case "closeAll": {
      let next = s;
      for (const t of s.tabs) if (!t.pinned && !t.dirty) next = withoutTab(next, t.id);
      return next;
    }
    case "renamed": {
      const hit = (id: string) => id === a.from || id.startsWith(`${a.from}/`);
      const re = (id: string) => (hit(id) ? a.to + id.slice(a.from.length) : id);
      return { tabs: s.tabs.map((t) => (hit(t.id) ? { ...t, id: re(t.id) } : t)), activeId: s.activeId === null ? null : re(s.activeId), mru: s.mru.map(re) };
    }
    case "removed": {
      // A deleted file's tab goes away unless it holds unsaved work (it is then kept, flagged by the caller).
      const t = s.tabs.find((x) => x.id === a.id);
      return t && !t.dirty ? withoutTab(s, a.id) : s;
    }
  }
}

export type CloseOutcome = "close" | "prompt" | "missing";

/** Whether closing `id` needs the unsaved-changes prompt. */
export function requestClose(s: TabsState, id: string): CloseOutcome {
  const t = s.tabs.find((x) => x.id === id);
  if (!t) return "missing";
  return t.dirty ? "prompt" : "close";
}

export function dirtyTabs(s: TabsState): Tab[] {
  return s.tabs.filter((t) => t.dirty);
}

// ---- session restore ------------------------------------------------------------------------

export interface SessionTabs {
  v: 1;
  tabs: { path: string; pinned: boolean; preview: boolean }[];
  active: string | null;
}

/** Only paths and flags are persisted, never content. */
export function serializeTabs(s: TabsState): SessionTabs {
  return { v: 1, tabs: s.tabs.map((t) => ({ path: t.id, pinned: t.pinned, preview: t.preview })), active: s.activeId };
}

/** Defensive parse of whatever storage returned; bounded and path-shape checked (the host re-validates). */
export function restoreTabs(raw: unknown): TabsState {
  if (typeof raw !== "object" || raw === null) return emptyTabs;
  const o = raw as Partial<SessionTabs>;
  if (o.v !== 1 || !Array.isArray(o.tabs)) return emptyTabs;
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const t of o.tabs.slice(0, MAX_TABS)) {
    if (typeof t !== "object" || t === null) continue;
    const path = (t as { path?: unknown }).path;
    if (!isSafeSessionPath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    tabs.push({ id: path, pinned: (t as { pinned?: unknown }).pinned === true, preview: (t as { preview?: unknown }).preview === true, dirty: false });
  }
  const ordered = normalise(tabs);
  const active = typeof o.active === "string" && seen.has(o.active) ? o.active : (ordered[0]?.id ?? null);
  return { tabs: ordered, activeId: active, mru: active ? [active] : [] };
}
