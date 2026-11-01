// Terminal dock open/height, like the Mac's UserDefaults keys. UI-only, no secrets.
const KEY = "llmide.terminalDock";
export interface TerminalDockPrefs { open: boolean; height: number }
export function readTerminalPrefs(storage: Storage | undefined = globalThis.localStorage): TerminalDockPrefs {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) ?? "{}") as { open?: unknown; height?: unknown };
    return { open: raw.open === true, height: typeof raw.height === "number" && Number.isFinite(raw.height) ? raw.height : 260 };
  } catch {
    return { open: false, height: 260 };
  }
}
export function writeTerminalPrefs(p: TerminalDockPrefs, storage: Storage | undefined = globalThis.localStorage): void {
  try { storage?.setItem(KEY, JSON.stringify(p)); } catch { /* session only */ }
}
