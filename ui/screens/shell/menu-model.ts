// Native menu command ids → shell requests. The macOS menu is built in Rust (`src-tauri/src/menu.rs`);
// this pure map keeps the webview side testable. Only navigation requests exist: no menu item runs a command.
import type { ShellEvent } from "./bus";
import type { RecentEntry } from "./host";

export type MenuCommand = "menu_quick_switch" | "menu_chat" | "menu_help";

export function menuAction(id: string): ShellEvent | null {
  switch (id) {
    case "menu_quick_switch": return { type: "goto-section", section: "welcome" };
    case "menu_chat": return { type: "goto-section", section: "chat" };
    case "menu_help": return { type: "goto-section", section: "welcome", anchor: "guide" };
    default: return null;
  }
}

/**
 * The rows Quick Switch lists: the recent projects minus the open one (the Mac's quick switcher leaves it out),
 * filtered by the search text. Each row keeps its index in the full list, which is what the host opens by.
 */
export function quickSwitchRows(recent: readonly RecentEntry[], activeRoot: string | null, query: string): { entry: RecentEntry; index: number }[] {
  const q = query.toLowerCase();
  return recent
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.root !== activeRoot && (!q || `${entry.name} ${entry.root}`.toLowerCase().includes(q)));
}
