// Tauri side of the Explorer's file watcher: a `Channel` the Rust host sends debounced batches into.
// Kept in `desktop/` because `@tauri-apps/api` is not resolvable from `ui/screens`; the screen loads this
// module lazily (same pattern as the PTY client in `src/terminal/ptyClient.ts`).
import type { Channel } from "@tauri-apps/api/core";
import { createChannel } from "../tauriChannel";

export interface WatchBatch {
  dirs: string[];
  files: string[];
  overflow: boolean;
}

export function createWatchChannel(onBatch: (b: WatchBatch) => void): Channel<WatchBatch> {
  // The payload comes from the host, but never trust the shape blindly.
  return createChannel<WatchBatch, WatchBatch>(
    (b) => (b && Array.isArray(b.dirs) && Array.isArray(b.files) ? { dirs: b.dirs.map(String), files: b.files.map(String), overflow: b.overflow === true } : undefined),
    onBatch,
  );
}
