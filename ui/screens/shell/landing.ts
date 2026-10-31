// Where the shell lands: the Welcome page while no project is open, the user's home section once one is.
// Pure (storage access is wrapped and optional) so it is tested with node.
import { isSelectable, type SectionId } from "./sections";

/**
 * Sections that can be the project home. The Mac offers any toolbar section (default Code Graph); the desktop
 * default is Explorer, the first section with real content in a fresh project (Code Graph needs a scan first).
 */
export const HOME_CHOICES: readonly SectionId[] = ["explorer", "graph", "library", "chat", "docgen", "visual"];
export const DEFAULT_HOME: SectionId = "explorer";

const HOME_KEY = "llmide.home";

export function isHomeChoice(v: unknown): v is SectionId {
  return typeof v === "string" && (HOME_CHOICES as readonly string[]).includes(v) && isSelectable(v);
}

/** The stored home preference, or the default when unset, unknown, or its section is not available. */
export function readHome(): SectionId {
  try {
    const v = globalThis.localStorage?.getItem(HOME_KEY);
    return isHomeChoice(v) ? v : DEFAULT_HOME;
  } catch {
    return DEFAULT_HOME;
  }
}

export function storeHome(id: SectionId): void {
  if (!isHomeChoice(id)) return;
  try {
    globalThis.localStorage?.setItem(HOME_KEY, id);
  } catch {
    // storage unavailable: the choice applies for this session only (the caller keeps it in state)
  }
}

/** A stored or requested home that is unusable falls back to Explorer. */
export function resolveHome(pref: string | null | undefined): SectionId {
  return isHomeChoice(pref) ? pref : DEFAULT_HOME;
}

export interface LandingInput {
  /** Project root on the previous observation; `undefined` before the first load finished. */
  prev: string | null | undefined;
  /** Project root now. */
  now: string | null;
  home: SectionId;
  /** A launch override (screenshot tooling) already chose the first section. */
  overridden: boolean;
}

/**
 * The section to switch to after the project state changed, or null to stay. First load: Home page (Welcome)
 * without a project, the home section with one. Then: opening a first project lands on the home section; closing
 * returns to Welcome; switching between projects stays where the user is.
 */
export function landingFor({ prev, now, home, overridden }: LandingInput): SectionId | null {
  if (prev === undefined) return overridden ? null : now === null ? "welcome" : home;
  if (prev === null && now !== null) return home;
  if (prev !== null && now === null) return "welcome";
  return null;
}
