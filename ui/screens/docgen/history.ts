// History of generated documents: the files in the output folder, newest first. The folder listing is paged by the
// host; we fold pages in as they arrive. Above HISTORY_MAX documents the newest are kept, so memory stays bounded and
// the list is usable after the first page.
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
/** Once this many are held, keep only the newest HISTORY_MAX (a sort per HISTORY_MAX new documents, not per page). */
const HISTORY_TRIM_AT = HISTORY_MAX * 2;

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

/** Keeps the newest HISTORY_MAX documents in `items` (sorts it in place). */
function keepNewest(items: HistoryItem[]): void {
  sortNewestFirst(items);
  if (items.length > HISTORY_MAX) items.length = HISTORY_MAX;
}

/** Lists the documents in `dir` (the output folder, project-relative), newest first. */
export async function loadHistory(fs: HistoryFs, signal: AbortSignal, onPage?: (items: readonly HistoryItem[]) => void, dir: string = GENERATED_DIR): Promise<HistoryResult> {
  const items: HistoryItem[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
    let page;
    try {
      page = await fs.list(dir, { offset, limit: HISTORY_PAGE, show_hidden: false });
    } catch (e) {
      const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : "";
      if (code === "not_found" && items.length === 0) return { items: [], capped: false, missing: true };
      throw e;
    }
    for (const e of page.entries) {
      if (e.kind !== "file" || e.symlink || !isDoc(e.name)) continue;
      total += 1;
      items.push({ path: e.path, name: e.name, size: e.size, mtimeMs: e.mtime_ms });
      if (items.length >= HISTORY_TRIM_AT) keepNewest(items);
    }
    onPage?.(items);
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  keepNewest(items);
  return { items, capped: total > HISTORY_MAX, missing: false };
}
