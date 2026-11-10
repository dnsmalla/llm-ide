// One terminal manager + one xterm runtime for every dock in the shell (Mac `TerminalDockSessions`): opening the
// dock from Explorer, the status bar or Ctrl+` reuses the same shells instead of spawning a second set.
import { TerminalManager, type TermHost } from "./manager";
import type { TerminalRuntime } from "../terminal/runtime-types";

declare const __FEATURE_TERMINAL__: boolean | undefined;
/** False only when this build excluded the Terminal feature; the lazy xterm import is then dead code. */
export const TERMINAL_BUILT: boolean = typeof __FEATURE_TERMINAL__ === "undefined" ? true : __FEATURE_TERMINAL__;

type DockModule = typeof import("../../../../desktop/src/terminal/dockRuntime");
let dockModule: Promise<DockModule> | null = null;
const loadDock = (): Promise<DockModule> =>
  TERMINAL_BUILT
    ? (dockModule ??= import("../../../../desktop/src/terminal/dockRuntime").catch((e) => { dockModule = null; throw e; }))
    : Promise.reject(new Error("Terminal is not part of this build"));

const lazyHost: TermHost = {
  status: async () => (await loadDock()).hostTerminal.status(),
  retryConsent: async () => (await loadDock()).hostTerminal.retryConsent(),
  spawn: async (c, r, cb) => (await loadDock()).hostTerminal.spawn(c, r, cb),
};

let singleton: TerminalManager | null = null;
export function sharedTerminalManager(): TerminalManager {
  return (singleton ??= new TerminalManager(lazyHost));
}

export async function loadTerminalRuntime(): Promise<TerminalRuntime> {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("the terminal runtime did not load within 15s")), 15_000);
  });
  const m = await Promise.race([loadDock(), timeout]);
  return { create: (el, o) => m.createTermView(el, o), openUrl: (u) => m.hostTerminal.openUrl(u) };
}
