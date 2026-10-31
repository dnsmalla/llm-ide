// The Explorer's left panel switcher (Mac `PanelSectionTabs`): Explorer / Search / Source Control.
// Pure state and key rules, tested without a DOM.

export type PanelId = "explorer" | "search" | "scm";

export interface PanelDef {
  id: PanelId;
  label: string;
  /** Shown in the tab tooltip. */
  shortcut: string;
}

export const PANELS: readonly PanelDef[] = [
  { id: "explorer", label: "Explorer", shortcut: "Mod+Shift+E" },
  { id: "search", label: "Search", shortcut: "Mod+Shift+F" },
  { id: "scm", label: "Source Control", shortcut: "Ctrl+Shift+G" },
];

export const DEFAULT_PANEL: PanelId = "explorer";

export function parsePanel(raw: unknown): PanelId {
  return PANELS.some((p) => p.id === raw) ? (raw as PanelId) : DEFAULT_PANEL;
}

/** Roving-tabindex arrow navigation inside the tablist (wraps). */
export function stepPanel(current: PanelId, delta: 1 | -1): PanelId {
  const i = PANELS.findIndex((p) => p.id === current);
  return PANELS[(i + delta + PANELS.length) % PANELS.length]!.id;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** Which panel a global shortcut asks for, or null. `Mod` is Cmd on macOS, Ctrl elsewhere. */
export function panelForKey(e: KeyLike, mac: boolean): PanelId | null {
  if (e.altKey || !e.shiftKey) return null;
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "e") return "explorer";
  if (mod && k === "f") return "search";
  // Source Control keeps Ctrl+Shift+G on every OS (the VS Code convention).
  if (e.ctrlKey && !e.metaKey && k === "g") return "scm";
  return null;
}

/** Terminal dock toggle: Ctrl+` on every OS. */
export function isDockToggleKey(e: KeyLike): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "`" || e.key === "Dead");
}
