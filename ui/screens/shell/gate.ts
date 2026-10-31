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
