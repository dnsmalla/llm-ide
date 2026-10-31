// Tauri side of the Explorer's file watcher: a `Channel` the Rust host sends debounced batches into.
// Kept in `desktop/` because `@tauri-apps/api` is not resolvable from `ui/screens`; the screen loads this
// module lazily (same pattern as the PTY client in `src/terminal/ptyClient.ts`).
import { Channel } from "@tauri-apps/api/core";

export interface WatchBatch {
  dirs: string[];
  files: string[];
  overflow: boolean;
}

export function createWatchChannel(onBatch: (b: WatchBatch) => void): Channel<WatchBatch> {
  const ch = new Channel<WatchBatch>();
  ch.onmessage = (b) => {
    // The payload comes from the host, but never trust the shape blindly.
    if (b && Array.isArray(b.dirs) && Array.isArray(b.files)) onBatch({ dirs: b.dirs.map(String), files: b.files.map(String), overflow: b.overflow === true });
  };
  return ch;
}
