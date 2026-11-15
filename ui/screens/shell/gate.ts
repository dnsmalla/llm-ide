// What the content area shows, given core and login state. Pure.
import type { StatusView } from "./status-view";

export type Gate =
  /** Screens are usable. */
  | "open"
  /** Full panel: the core is down and was never usable, or it will not come back (fatal). */
  | "core"
  /** Screens stay mounted (state kept) under a banner while a crashed core restarts. */
  | "restarting"
  /** The core is up but nobody is signed in. */
  | "login";

export interface GateInput {
  view: StatusView;
  signedIn: boolean;
  /** True once the screens have been usable at least once (they stay mounted afterwards). */
  everUsable: boolean;
  /** The Spike route needs neither the core nor a login. */
  bypass: boolean;
}

export function computeGate({ view, signedIn, everUsable, bypass }: GateInput): Gate {
  if (bypass) return "open";
  if (view.down) return view.fatal || !everUsable ? "core" : "restarting";
  return signedIn ? "open" : "login";
}

/** Screens are mounted once usable and stay mounted, so a restart or re-login never drops their state. */
export function shouldMountSections(gate: Gate, everUsable: boolean): boolean {
  return gate === "open" || everUsable;
}

/** Content is inert (no focus, no input) whenever something sits over it. */
export function isInert(gate: Gate): boolean {
  return gate !== "open";
}

/**
 * ssh mode with the core down: the Settings section stays mounted and usable, because the password or the server
 * is changed there. Only this section, only this mode and only the `core` gate; login and the other gates are unchanged.
 */
export function settingsReachableOverCoreDown(mode: string | undefined, gate: Gate, active: string): boolean {
  return mode === "ssh" && gate === "core" && active === "settings";
}

/** A section is inert under a gate, except Settings while `settingsReachable` holds (the rest of the app stays inert). */
export function sectionInert(gate: Gate, sectionId: string, settingsReachable: boolean): boolean {
  return isInert(gate) && !(gate === "core" && settingsReachable && sectionId === "settings");
}
