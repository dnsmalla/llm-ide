// The desktop's feature model, mirroring the Mac's AppFeature / ProfilePreset (Core/FeatureToggles/AppFeature.swift).
// Pure: no React, no DOM, no host. The same keys are the core's LLMIDE_FEATURES keys, the host pref list and the
// Vite build flags, so one vocabulary decides what the UI shows and what a reduced build contains.

export type AppFeature =
  | "agent_chat"
  | "file_explorer"
  | "code_graph_3d"
  | "gantt_issues"
  | "terminal"
  | "doc_gen"
  | "mobile_sync"
  | "auto_tasks";

export interface FeatureDef {
  id: AppFeature;
  /** The Mac's display name. */
  label: string;
  /** What turning it off removes, in one line. */
  removes: string;
  /** Features that must stay on (the Mac's requiredDependencies). */
  requires: readonly AppFeature[];
  /** False when this build cannot exclude it (agent_chat, as on the Mac). */
  excludable: boolean;
}

export const FEATURES: readonly FeatureDef[] = [
  { id: "file_explorer", label: "File Explorer", removes: "the Explorer, tabs, Monaco and source control", requires: [], excludable: true },
  { id: "agent_chat", label: "AI Agent Chat", removes: "the Chat section and the Explorer's Code Assistant", requires: [], excludable: false },
  { id: "code_graph_3d", label: "Code Graph Engine", removes: "the Graph section and graph memory", requires: ["file_explorer"], excludable: true },
  { id: "gantt_issues", label: "Gantt & Issue Board", removes: "Issues, Gantt and the issue schedule", requires: ["file_explorer"], excludable: true },
  { id: "terminal", label: "Integrated Terminal", removes: "the terminal dock and its xterm bundle", requires: [], excludable: true },
  { id: "doc_gen", label: "Document Generator", removes: "Doc Gen, Visual and the Mermaid renderer entry", requires: ["file_explorer"], excludable: true },
  { id: "mobile_sync", label: "Mobile Companion Sync", removes: "the phone bridge in desktop builds (the Swift app serves it until the relay)", requires: [], excludable: true },
  { id: "auto_tasks", label: "Auto-Tasks & Activity Capture", removes: "Auto Tasks, Loop and the job-driven runs", requires: [], excludable: true },
];

export const ALL_FEATURES: readonly AppFeature[] = FEATURES.map((f) => f.id);
const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));
export const featureDef = (id: AppFeature): FeatureDef => BY_ID.get(id)!;
export const isFeature = (v: unknown): v is AppFeature => typeof v === "string" && BY_ID.has(v as AppFeature);

export interface ProfilePreset {
  id: "full" | "focused" | "minimal" | "custom";
  /** The Mac's preset names. */
  label: string;
  features: readonly AppFeature[] | null; // null = custom (whatever is stored)
}

export const PRESETS: readonly ProfilePreset[] = [
  { id: "full", label: "Full IDE + AI (Default)", features: ALL_FEATURES },
  { id: "focused", label: "Focused AI Assistant", features: ["agent_chat", "file_explorer", "doc_gen"] },
  { id: "minimal", label: "Minimal Code Editor", features: ["file_explorer", "terminal"] },
  { id: "custom", label: "Custom System Configuration", features: null },
];

/** The preset a feature set matches, or "custom". */
export function presetFor(features: Iterable<AppFeature>): ProfilePreset["id"] {
  const set = new Set(features);
  for (const p of PRESETS) {
    if (!p.features) continue;
    if (p.features.length === set.size && p.features.every((f) => set.has(f))) return p.id;
  }
  return "custom";
}

/** The Mac's `AppFeature.validated`: drop features whose dependencies are not satisfied, to a fixed point. */
export function validateFeatures(input: Iterable<string>): Set<AppFeature> {
  const set = new Set<AppFeature>();
  for (const v of input) if (isFeature(v)) set.add(v);
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of [...set]) {
      if (!featureDef(f).requires.every((r) => set.has(r))) {
        set.delete(f);
        changed = true;
      }
    }
  }
  return set;
}

/** The stored pref list: empty means "every feature" (the host's own convention), unknown keys are dropped. */
export function featuresFromPrefs(list: readonly string[] | null | undefined): Set<AppFeature> {
  if (!Array.isArray(list) || list.length === 0) return new Set(ALL_FEATURES);
  return validateFeatures(list);
}

/** Features this binary was built with. `flags` are the Vite `__FEATURE_*__` defines (undefined in tests = all). */
export type FeatureFlags = Partial<Record<AppFeature, boolean>>;

export const BUILD_FLAGS: FeatureFlags = {
  file_explorer: typeof __FEATURE_FILE_EXPLORER__ === "boolean" ? __FEATURE_FILE_EXPLORER__ : undefined,
  agent_chat: true, // never excludable
  code_graph_3d: typeof __FEATURE_CODE_GRAPH_3D__ === "boolean" ? __FEATURE_CODE_GRAPH_3D__ : undefined,
  gantt_issues: typeof __FEATURE_GANTT_ISSUES__ === "boolean" ? __FEATURE_GANTT_ISSUES__ : undefined,
  terminal: typeof __FEATURE_TERMINAL__ === "boolean" ? __FEATURE_TERMINAL__ : undefined,
  doc_gen: typeof __FEATURE_DOC_GEN__ === "boolean" ? __FEATURE_DOC_GEN__ : undefined,
  mobile_sync: typeof __FEATURE_MOBILE_SYNC__ === "boolean" ? __FEATURE_MOBILE_SYNC__ : undefined,
  auto_tasks: typeof __FEATURE_AUTO_TASKS__ === "boolean" ? __FEATURE_AUTO_TASKS__ : undefined,
};

/** Compiled features, honouring dependency closure (a compiled graph needs a compiled Explorer). */
export function compiledFeatures(flags: FeatureFlags = BUILD_FLAGS): Set<AppFeature> {
  const on = ALL_FEATURES.filter((f) => flags[f] !== false);
  return validateFeatures(on);
}

declare const __FEATURE_FILE_EXPLORER__: boolean | undefined;
declare const __FEATURE_CODE_GRAPH_3D__: boolean | undefined;
declare const __FEATURE_GANTT_ISSUES__: boolean | undefined;
declare const __FEATURE_TERMINAL__: boolean | undefined;
declare const __FEATURE_DOC_GEN__: boolean | undefined;
declare const __FEATURE_MOBILE_SYNC__: boolean | undefined;
declare const __FEATURE_AUTO_TASKS__: boolean | undefined;

/** What is usable now: active ∩ compiled ∩ dependencies. */
export function usableFeatures(active: ReadonlySet<AppFeature>, compiled: ReadonlySet<AppFeature>): Set<AppFeature> {
  return validateFeatures([...active].filter((f) => compiled.has(f)));
}

/** The feature a section belongs to; Library, Settings, Home and Spike are always available. */
export function featureForSection(section: string): AppFeature | null {
  switch (section) {
    case "explorer":
      return "file_explorer";
    case "graph":
      return "code_graph_3d";
    case "issues":
    case "gantt":
      return "gantt_issues";
    case "docgen":
    case "visual":
      return "doc_gen";
    case "autotasks":
    case "loop":
      return "auto_tasks";
    case "chat":
      return "agent_chat";
    default:
      return null;
  }
}

export function isSectionEnabled(section: string, usable: ReadonlySet<AppFeature>): boolean {
  const f = featureForSection(section);
  return f === null || usable.has(f);
}

/**
 * What the shell says when it leaves a section that is not usable (the Mac's placeholder names the same two cases).
 * A section whose feature is compiled out gets the build sentence; a section that is off gets the Settings path.
 */
export function disabledSectionText(section: string, label: string, compiled: ReadonlySet<AppFeature>): string {
  const f = featureForSection(section);
  if (f !== null && !compiled.has(f)) return `${label} is not included in this build.`;
  return `${label} is currently disabled. You can re-enable this feature in Settings → Workspace.`;
}

/**
 * The notice left behind when a disabled section sends the user to their home section. It belongs to the section the
 * user landed on (`at`), so it stops showing as soon as they navigate anywhere else (the Mac's placeholder is the
 * disabled section's own content, so it is gone on the next navigation too).
 */
export interface SectionNotice {
  text: string;
  at: string;
}

/** The notice while the user is still on the section it was shown on; null once they navigate away. */
export function keepSectionNotice(notice: SectionNotice | null, active: string): SectionNotice | null {
  return notice && notice.at === active ? notice : null;
}

/** The dependency sentence shown under a switch that other features require. */
export function dependentsOf(f: AppFeature): AppFeature[] {
  return FEATURES.filter((x) => x.requires.includes(f)).map((x) => x.id);
}

export const FEATURE_TEXT = {
  compiledOut: "Not compiled into this build",
  pending: "Applies the next time the app opens",
  compiled: "Compiled in",
  always: "Always compiled",
} as const;
