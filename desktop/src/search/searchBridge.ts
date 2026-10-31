// Tauri side of the Explorer's project search: a `Channel` the Rust host streams result chunks into.
// Lives in `desktop/` because `@tauri-apps/api` is not resolvable from `ui/screens` (same pattern as
// `editor/explorerBridge.ts`); the screen loads it lazily.
import { Channel } from "@tauri-apps/api/core";

export type SearchWireEvent = { type: "chunk"; id: number; files: unknown[] } | { type: "done"; id: number; [k: string]: unknown };

export function createSearchChannel(onEvent: (e: never) => void): Channel<SearchWireEvent> {
  const ch = new Channel<SearchWireEvent>();
  ch.onmessage = (e) => {
    // The host is trusted but the shape is still checked: the controller decodes the details defensively.
    if (e && typeof e === "object" && typeof e.id === "number" && (e.type === "chunk" || e.type === "done")) onEvent(e as never);
  };
  return ch;
}
