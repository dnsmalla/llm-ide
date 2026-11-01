// Native menu command ids → shell requests. The macOS menu is built in Rust (`src-tauri/src/menu.rs`);
// this pure map keeps the webview side testable. Only navigation requests exist: no menu item runs a command.
import type { ShellEvent } from "./bus";

export type MenuCommand = "menu_settings" | "menu_quick_switch" | "menu_chat" | "menu_help";

export function menuAction(id: string): ShellEvent | null {
  switch (id) {
    case "menu_settings": return { type: "goto-section", section: "settings" };
    case "menu_quick_switch": return { type: "goto-section", section: "welcome" };
    case "menu_chat": return { type: "goto-section", section: "chat" };
    case "menu_help": return { type: "goto-section", section: "welcome", anchor: "guide" };
    default: return null;
  }
}
