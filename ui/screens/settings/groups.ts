// The Settings page's groups: the SAME list, order, titles and icons as the Mac's one "App" page
// (mac/.../Features/Settings/Views/SettingsView.swift; drift is a test failure, see tests/groups.test.ts).
// Pure: no React, no DOM. The page renders these as collapsible rows; a group's body comes from the registry.
import type { IconName } from "@llmide/ui-kit";

/** What the desktop does for a group today. Drives the honest notice and the mirror map. */
export type GroupStatus =
  | "works" //          fully usable on the desktop
  | "partial" //        part of the Mac group works; the rest says so
  | "host" //           needs a desktop host command that does not exist yet
  | "core-route" //     needs a core route that does not exist yet
  | "mac-only"; //      a Swift-app feature with no desktop counterpart

export interface GroupDef {
  /** Stable id: the deep-link anchor (`settings:<id>`) and the storage key. */
  id: string;
  /** The Mac's title, verbatim (the kit upper-cases it for display). */
  title: string;
  /** The Mac's SF Symbol, recorded so the icon mapping is reviewable and drift-checked. */
  sf: string;
  /** The nearest Lucide glyph in the kit. */
  icon: IconName;
  status: GroupStatus;
  /** "app" groups always show; "project" groups only while a project is open (like the Mac). */
  band: "app" | "project";
}

export const APP_GROUPS: readonly GroupDef[] = [
  { id: "workspace", title: "Workspace", sf: "slider.horizontal.3", icon: "sliders-horizontal", status: "partial", band: "app" },
  { id: "build", title: "Build", sf: "hammer", icon: "hammer", status: "mac-only", band: "app" },
  { id: "server", title: "Server & Backend", sf: "server.rack", icon: "server", status: "partial", band: "app" },
  { id: "connections", title: "Connections", sf: "tray.and.arrow.down", icon: "plug", status: "partial", band: "app" },
  { id: "updates", title: "Updates & About", sf: "arrow.down.circle", icon: "circle-arrow-down", status: "partial", band: "app" },
  { id: "mobile", title: "Mobile Control", sf: "iphone", icon: "smartphone", status: "mac-only", band: "app" },
  { id: "general", title: "General", sf: "globe", icon: "globe", status: "partial", band: "app" },
  { id: "tool-permissions", title: "Tool permissions", sf: "hand.raised", icon: "hand", status: "works", band: "app" },
  { id: "agent-sdk", title: "Claude Agent SDK", sf: "shippingbox", icon: "package", status: "works", band: "app" },
  { id: "token-saving", title: "Token Saving", sf: "leaf", icon: "leaf", status: "host", band: "app" },
  { id: "providers", title: "Providers", sf: "key.horizontal", icon: "key-round", status: "works", band: "app" },
  { id: "model-routing", title: "Model routing", sf: "dial.medium", icon: "gauge", status: "works", band: "app" },
  { id: "loop-defaults", title: "Loop defaults", sf: "repeat", icon: "repeat", status: "host", band: "app" },
  { id: "doc-gen", title: "Doc Gen files", sf: "server.rack", icon: "hard-drive", status: "host", band: "app" },
  { id: "agent-history", title: "Agent history", sf: "clock.arrow.circlepath", icon: "rotate-ccw-clock", status: "works", band: "app" },
  { id: "folder-trust", title: "Folder trust", sf: "lock.shield", icon: "shield-check", status: "works", band: "app" },
  { id: "extension-sources", title: "Extension sources", sf: "checklist", icon: "list-checks", status: "works", band: "app" },
  { id: "optional-components", title: "Optional components", sf: "puzzlepiece.extension", icon: "puzzle", status: "host", band: "app" },
  { id: "self-heal", title: "Self-Heal", sf: "stethoscope", icon: "stethoscope", status: "mac-only", band: "app" },
];

export const PROJECT_GROUPS: readonly GroupDef[] = [
  { id: "paths", title: "Paths", sf: "folder.badge.gearshape", icon: "folder-cog", status: "host", band: "project" },
  { id: "repositories", title: "Repositories", sf: "arrow.triangle.branch", icon: "git-branch", status: "core-route", band: "project" },
  { id: "memory", title: "Memory", sf: "brain", icon: "brain", status: "host", band: "project" },
  { id: "code-graph", title: "Code Graph", sf: "cube.transparent", icon: "network", status: "host", band: "project" },
];

export const ALL_GROUPS: readonly GroupDef[] = [...APP_GROUPS, ...PROJECT_GROUPS];

/** Mac cards that are not groups on the desktop because the desktop folds them into another group. */
export const MERGED_MAC_CARDS: Readonly<Record<string, string>> = {
  "Chat archive": "agent-history", // the archiving mode lives inside Agent history
};

/** Anchors the app used before the Mac layout (and short forms the shell may send) -> group id. */
const LEGACY_ANCHORS: Readonly<Record<string, string>> = {
  routing: "model-routing",
  "extensions-trust": "folder-trust",
  about: "updates",
  account: "general",
  appearance: "general",
  features: "workspace",
};

const IDS: ReadonlySet<string> = new Set(ALL_GROUPS.map((g) => g.id));

/** `settings:<id>`, `<id>` or an old anchor -> a group id; anything unknown (or hostile) -> null. */
export function resolveAnchor(anchor: string | null | undefined): string | null {
  if (typeof anchor !== "string" || anchor.length === 0 || anchor.length > 64) return null;
  const bare = anchor.startsWith("settings:") ? anchor.slice("settings:".length) : anchor;
  if (IDS.has(bare)) return bare;
  const mapped = LEGACY_ANCHORS[bare];
  return mapped !== undefined && IDS.has(mapped) ? mapped : null;
}

// ---- expanded state (webview localStorage, one key per group) -----------------------------------

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const expandedKey = (id: string): string => `settings.group.${id}.expanded`;

/** The browser's storage when it works; null in a private window, with site data blocked, or on the server. */
export function defaultStorage(): KeyValueStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Which groups are open. Default collapsed (the page is an index, like the Mac). Storage may throw or lie: both are survivable. */
export class ExpandedGroups {
  readonly #storage: KeyValueStorage | null;
  readonly #memory = new Map<string, boolean>();

  constructor(storage: KeyValueStorage | null = defaultStorage()) {
    this.#storage = storage;
  }

  isOpen(id: string): boolean {
    const m = this.#memory.get(id);
    if (m !== undefined) return m;
    let v = false;
    try {
      v = this.#storage?.getItem(expandedKey(id)) === "true";
    } catch {
      v = false;
    }
    this.#memory.set(id, v);
    return v;
  }

  set(id: string, open: boolean): void {
    this.#memory.set(id, open);
    try {
      this.#storage?.setItem(expandedKey(id), String(open));
    } catch {
      // storage unavailable: the choice lasts for this session only
    }
  }

  toggle(id: string): boolean {
    const next = !this.isOpen(id);
    this.set(id, next);
    return next;
  }
}
