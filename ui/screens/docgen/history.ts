// History of generated documents: the files in `llm-doc/generated/`, newest first. The folder listing is paged by
// the host; we fold pages in as they arrive and cap the total, so a folder with tens of thousands of documents costs
// bounded memory and the list is usable after the first page.
import type { FsApi } from "../explorer/fs";
import { GENERATED_DIR } from "./naming.ts";

export interface HistoryItem {
  /** Project-relative path. */
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export const HISTORY_PAGE = 1000;
export const HISTORY_MAX = 50_000;

export type HistoryFs = Pick<FsApi, "list">;

export interface HistoryResult {
  items: HistoryItem[];
  /** True when the folder holds more than `HISTORY_MAX` documents (the oldest are not shown). */
  capped: boolean;
  /** The folder does not exist yet (nothing generated). */
  missing: boolean;
}

const isDoc = (name: string): boolean => /\.(md|markdown|txt)$/i.test(name);

export function sortNewestFirst(items: HistoryItem[]): HistoryItem[] {
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function loadHistory(fs: HistoryFs, signal: AbortSignal, onPage?: (items: readonly HistoryItem[]) => void): Promise<HistoryResult> {
  const items: HistoryItem[] = [];
  let offset = 0;
  let capped = false;
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    let page;
    try {
      page = await fs.list(GENERATED_DIR, { offset, limit: HISTORY_PAGE, show_hidden: false });
    } catch (e) {
      const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : "";
      if (code === "not_found" && items.length === 0) return { items: [], capped: false, missing: true };
      throw e;
    }
    for (const e of page.entries) {
      if (e.kind !== "file" || e.symlink || !isDoc(e.name)) continue;
      if (items.length >= HISTORY_MAX) {
        capped = true;
        break;
      }
      items.push({ path: e.path, name: e.name, size: e.size, mtimeMs: e.mtime_ms });
    }
    onPage?.(items);
    if (capped || page.next_offset === null) break;
    offset = page.next_offset;
  }
  return { items: sortNewestFirst(items), capped, missing: false };
}
