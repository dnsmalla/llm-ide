// Section registry and navigation state. Pure (no React, no DOM) so it is tested with node.

export type SectionId = "welcome" | "chat" | "explorer" | "library" | "settings" | "graph" | "issues" | "gantt" | "loop" | "docgen" | "visual" | "autotasks" | "conflicts" | "spike";

export interface SectionDef {
  id: SectionId;
  label: string;
  /** Disabled sections are placeholders for later phases: listed, not selectable. */
  enabled: boolean;
  /** Short reason shown as tooltip on a disabled item. */
  note?: string;
  /** `Ctrl/Cmd+<n>`; unset for items without a shortcut. */
  shortcut?: number;
}

const SOON = "Planned for a later phase";

/**
 * Section registry. The top toolbar (`toolbar-model.ts`) lists the ids of `TOOLBAR_IDS` in the Mac's
 * `ShellSection.toolbarOrder` (a drift test parses the Swift source); Home (the Welcome page) is the toolbar's Home
 * button, Settings lives in the account menu and Chat in the status bar and the Explorer dock, like the Mac. Review
 * Conflicts has no desktop screen yet (listed, "Soon"). The developer-only Spike item is hidden unless developer
 * tools are on.
 */
export const SECTIONS: readonly SectionDef[] = [
  { id: "welcome", label: "Home", enabled: true },
  { id: "explorer", label: "Explorer", enabled: true, shortcut: 2 },
  { id: "graph", label: "Graph", enabled: true },
  { id: "autotasks", label: "Auto Tasks", enabled: false, note: SOON },
  { id: "conflicts", label: "Review Conflicts", enabled: false, note: SOON },
  { id: "issues", label: "Issues", enabled: false, note: SOON },
  { id: "gantt", label: "Gantt", enabled: false, note: SOON },
  { id: "loop", label: "Loop", enabled: false, note: SOON },
  { id: "docgen", label: "Doc Gen", enabled: true },
  { id: "visual", label: "Visual", enabled: true },
  { id: "library", label: "Library", enabled: true, shortcut: 3 },
  { id: "chat", label: "Chat", enabled: true, shortcut: 1 },
  { id: "settings", label: "Settings", enabled: true, shortcut: 4 },
  { id: "spike", label: "Spike", enabled: true, note: "Phase 0 bench, graph, terminal and editor spikes (developer tool)" },
];

// ---- developer tools (the Spike item) ------------------------------------------------------------------------
// A first-time user never needs Spike: it is hidden unless this is a dev build (`vite dev`), the user turned on
// "developer tools" (storage flag below; Settings > About can call `setDevTools`), or this launch opened a spike route.

const DEV_KEY = "llmide.devtools";
let devSession = false;
const devListeners = new Set<() => void>();

function devFlagFromStorage(): boolean {
  try {
    return globalThis.localStorage?.getItem(DEV_KEY) === "1";
  } catch {
    return false;
  }
}

function devBuild(): boolean {
  try {
    return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
}

/** True when the developer-only Spike item is shown. */
export function devToolsEnabled(): boolean {
  return devSession || devBuild() || devFlagFromStorage();
}

/** Turn developer tools on or off (persisted per viewer; a storage failure keeps the choice for this session). */
export function setDevTools(on: boolean): void {
  devSession = on;
  try {
    if (on) globalThis.localStorage?.setItem(DEV_KEY, "1");
    else globalThis.localStorage?.removeItem(DEV_KEY);
  } catch {
    // storage unavailable: session only
  }
  for (const l of [...devListeners]) l();
}

/** Show developer tools for this launch only (a spike launch override). Not persisted. */
export function enableDevToolsForSession(): void {
  if (devSession) return;
  devSession = true;
  for (const l of [...devListeners]) l();
}

export function subscribeDevTools(l: () => void): () => void {
  devListeners.add(l);
  return () => devListeners.delete(l);
}

/** Sections to list in the nav now (Spike only with developer tools). */
export function visibleSections(): readonly SectionDef[] {
  return devToolsEnabled() ? SECTIONS : SECTIONS.filter((s) => s.id !== "spike");
}

const BY_ID = new Map<string, SectionDef>(SECTIONS.map((s) => [s.id, s]));

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === "string" && BY_ID.has(v);
}

export function isSelectable(id: string): id is SectionId {
  const d = BY_ID.get(id);
  return d?.enabled === true && (id !== "spike" || devToolsEnabled());
}

/** Sections reachable by keyboard navigation, in nav order. */
export function selectableSections(): readonly SectionDef[] {
  return visibleSections().filter((s) => s.enabled);
}

/** What opens when nothing else is known: the Welcome page (it explains the next step). */
export const DEFAULT_SECTION: SectionId = "welcome";

export interface NavState {
  active: SectionId;
  /** Sections that were opened at least once: they stay mounted (hidden) to keep their state. */
  visited: readonly SectionId[];
}

export type NavAction = { type: "select"; id: string } | { type: "step"; delta: 1 | -1 };

export function initialNav(active: string | null | undefined): NavState {
  const id: SectionId = active && isSelectable(active) ? active : DEFAULT_SECTION;
  return { active: id, visited: [id] };
}

export function navReducer(state: NavState, action: NavAction): NavState {
  let id: SectionId | null = null;
  if (action.type === "select") {
    if (isSelectable(action.id)) id = action.id;
  } else {
    const list = selectableSections();
    const i = list.findIndex((s) => s.id === state.active);
    const n = list.length;
    id = list[(i + action.delta + n) % n]?.id ?? null;
  }
  if (id === null || id === state.active) return state;
  return { active: id, visited: state.visited.includes(id) ? state.visited : [...state.visited, id] };
}

/** Props every section screen receives from the shell. */
export interface SectionProps {
  /** False while another section is shown: pause polling, timers and focus grabbing. */
  active: boolean;
  /** Root of the open project, or null. The host owns the path; never edit it. */
  projectRoot: string | null;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `Ctrl/Cmd+1..4` -> section id; `Ctrl/Cmd+[` / `]` handled by `stepForKey`. */
export function sectionForShortcut(e: KeyLike): SectionId | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  if (!/^[1-9]$/.test(e.key)) return null;
  const n = Number(e.key);
  return selectableSections().find((s) => s.shortcut === n)?.id ?? null;
}

/** Roving-tabindex keys inside the nav list. */
export function navKeyTarget(key: string, index: number, count: number): number | null {
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Section for this launch. `override` is the host's `section_override` (screenshot tooling) and
 * `autobench` the host's `autobench_mode`: any autobench or a legacy spike id opens the Spike route.
 */
export const SPIKE_TABS = ["graph", "editor", "terminal", "chat", "bench"] as const;
export type SpikeTab = (typeof SPIKE_TABS)[number];
export function isSpikeTab(v: unknown): v is SpikeTab {
  return typeof v === "string" && (SPIKE_TABS as readonly string[]).includes(v);
}

export function launchSection(autobench: string | null, override: string | null): SectionId {
  if (autobench) return "spike";
  if (override) {
    if (isSpikeTab(override) || override === "spike") return "spike";
    if (isSelectable(override)) return override;
  }
  return DEFAULT_SECTION;
}

const STORAGE_KEY = "llmide.section";

/** Last section the user used (per-viewer convenience; any storage failure -> null). */
export function readStoredSection(): SectionId | null {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    return v && isSelectable(v) && v !== "spike" ? v : null;
  } catch {
    return null;
  }
}

export function storeSection(id: SectionId): void {
  if (id === "spike") return;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // storage unavailable: the choice applies for this session only
  }
}
