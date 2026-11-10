// One terminal-dock open state for every section: Explorer renders the dock inside its editor column, the shell
// renders it above the status bar for every other section. The state (and its pref) is shared.
import { useSyncExternalStore } from "react";
import { readTerminalPrefs, writeTerminalPrefs } from "../../shell/terminal-prefs";

let open = false;
let loaded = false;
const listeners = new Set<() => void>();

function ensure(): void {
  if (loaded) return;
  loaded = true;
  open = readTerminalPrefs().open;
}

export function terminalDockOpen(): boolean {
  ensure();
  return open;
}

export function setTerminalDockOpen(next: boolean): void {
  ensure();
  if (open === next) return;
  open = next;
  writeTerminalPrefs({ open, height: readTerminalPrefs().height });
  for (const l of [...listeners]) l();
}

export function toggleTerminalDock(): void {
  setTerminalDockOpen(!terminalDockOpen());
}

export function subscribeTerminalDock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalDockOpen(): boolean {
  return useSyncExternalStore(subscribeTerminalDock, terminalDockOpen, () => false);
}
