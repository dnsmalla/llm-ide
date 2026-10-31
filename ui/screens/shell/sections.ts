// Section registry and navigation state. Pure (no React, no DOM) so it is tested with node.

export type SectionId = "chat" | "explorer" | "library" | "settings" | "graph" | "issues" | "docgen" | "visual" | "autotasks" | "spike";

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

export const SECTIONS: readonly SectionDef[] = [
  { id: "chat", label: "Chat", enabled: true, shortcut: 1 },
  { id: "explorer", label: "Explorer", enabled: true, shortcut: 2 },
  { id: "library", label: "Library", enabled: true, shortcut: 3 },
  { id: "settings", label: "Settings", enabled: true, shortcut: 4 },
  { id: "graph", label: "Code Graph", enabled: true },
  { id: "issues", label: "Issues & Gantt", enabled: false, note: "Planned for a later phase" },
  { id: "docgen", label: "Doc Gen", enabled: true },
  { id: "visual", label: "Visual", enabled: true },
  { id: "autotasks", label: "Auto Tasks", enabled: false, note: "Planned for a later phase" },
  { id: "spike", label: "Spike", enabled: true, note: "Phase 0 bench, graph, terminal and editor spikes (developer tool)" },
];

const BY_ID = new Map<string, SectionDef>(SECTIONS.map((s) => [s.id, s]));

export function isSectionId(v: unknown): v is SectionId {
  return typeof v === "string" && BY_ID.has(v);
}

export function isSelectable(id: string): id is SectionId {
  return BY_ID.get(id)?.enabled === true;
}

/** Sections reachable by keyboard navigation, in nav order. */
export const SELECTABLE: readonly SectionDef[] = SECTIONS.filter((s) => s.enabled);

export const DEFAULT_SECTION: SectionId = "chat";

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
    const i = SELECTABLE.findIndex((s) => s.id === state.active);
    const n = SELECTABLE.length;
    id = SELECTABLE[(i + action.delta + n) % n]?.id ?? null;
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
  return SECTIONS.find((s) => s.enabled && s.shortcut === n)?.id ?? null;
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
