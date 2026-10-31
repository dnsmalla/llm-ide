// Bounded, cancellable walk of a project folder to collect text-like files as sources. Uses the host's root-confined
// listing with the project's ignore rules (hidden and git-ignored entries are skipped), so `node_modules`, build
// output and `.git` never enter a selection. Hard limits on files, folders and depth keep a monorepo from freezing
// the screen or the selection.
import type { FsApi } from "../explorer/fs";
import { fileItem, type SourceItem } from "./sources.ts";

export type WalkFs = Pick<FsApi, "list">;

export const WALK_MAX_FILES = 2_000;
export const WALK_MAX_DIRS = 1_000;
export const WALK_MAX_DEPTH = 12;
/** A single file over this is not offered as a source (the core keeps at most 50,000 characters of it anyway). */
export const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024;
const PAGE = 1000;

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "heic", "avif", "svgz", "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "dmg", "iso", "exe", "dll", "so", "dylib", "a", "o", "obj",
  "class", "pyc", "wasm", "bin", "dat", "db", "sqlite", "sqlite3", "mp3", "mp4", "mov", "avi", "mkv", "wav", "flac", "ogg", "woff", "woff2", "ttf", "otf", "eot", "psd", "ai", "key", "pages", "numbers", "xlsx", "xls", "docx", "doc", "pptx", "ppt", "lock",
]);

/** Cheap name filter: skips known binary extensions. Content sniffing happens at read time (binary -> skipped, reported). */
export function looksTextual(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i <= 0) return true; // no extension (Makefile, LICENSE) or dotfile
  return !BINARY_EXT.has(name.slice(i + 1).toLowerCase());
}

export interface WalkProgress {
  dirs: number;
  files: number;
}

export interface WalkResult {
  items: SourceItem[];
  /** A limit stopped the walk early: more files exist than were collected. */
  capped: boolean;
  skippedLarge: number;
  skippedBinary: number;
}

export interface WalkOptions {
  maxFiles?: number;
  maxDirs?: number;
  maxDepth?: number;
}

export async function walkFolder(fs: WalkFs, start: string, signal: AbortSignal, onProgress?: (p: WalkProgress) => void, opts: WalkOptions = {}): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? WALK_MAX_FILES;
  const maxDirs = opts.maxDirs ?? WALK_MAX_DIRS;
  const maxDepth = opts.maxDepth ?? WALK_MAX_DEPTH;
  const items: SourceItem[] = [];
  let capped = false;
  let skippedLarge = 0;
  let skippedBinary = 0;
  let dirs = 0;
  const queue: { path: string; depth: number }[] = [{ path: start, depth: 0 }];
  while (queue.length > 0) {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    const cur = queue.shift()!;
    if (dirs >= maxDirs) {
      capped = true;
      break;
    }
    dirs += 1;
    let offset = 0;
    for (;;) {
      const page = await fs.list(cur.path, { offset, limit: PAGE, show_hidden: false, gitignore: true, hide_ignored: true });
      for (const e of page.entries) {
        if (e.symlink || e.hidden || e.ignored) continue;
        if (e.kind === "dir") {
          if (cur.depth + 1 > maxDepth) capped = true;
          else queue.push({ path: e.path, depth: cur.depth + 1 });
        } else if (e.kind === "file") {
          if (!looksTextual(e.name)) {
            skippedBinary += 1;
            continue;
          }
          if (e.size > MAX_SOURCE_FILE_BYTES) {
            skippedLarge += 1;
            continue;
          }
          if (items.length >= maxFiles) {
            capped = true;
            continue;
          }
          items.push(fileItem(e.path, e.size));
        }
      }
      onProgress?.({ dirs, files: items.length });
      if (page.next_offset === null || items.length >= maxFiles) {
        if (page.next_offset !== null) capped = true;
        break;
      }
      offset = page.next_offset;
    }
    if (items.length >= maxFiles && queue.length > 0) {
      capped = true;
      break;
    }
  }
  return { items, capped, skippedLarge, skippedBinary };
}
