// The Review section's file side: the Mac's ReviewConfig tree categories are code and LLM Doc. This model turns the
// host's directory listings into sorted rows (folders first) and keeps the tree's roots fixed, so the page can never
// wander into the rest of the project the way a generic file browser would.
export interface ReviewEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export const REVIEW_ROOTS: readonly { path: string; label: string }[] = [
  { path: "code", label: "Code" },
  { path: "llm-doc", label: "LLM Doc" },
];

const MAX_ENTRIES = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Safe project-relative path: no absolute path, no `.`/`..` segment, no control characters. */
export function safeReviewPath(path: string): string | null {
  const t = path.trim();
  if (!t || t.startsWith("/") || t.length > 1024 || /[\u0000-\u001f]/.test(t)) return null;
  const parts = t.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

/** `fs_list_dir` entries under `dir`: hidden/symlink/ignored rows dropped, dirs first, names sorted. */
export function decodeEntries(body: unknown): ReviewEntry[] {
  const list = isRecord(body) && Array.isArray(body.entries) ? body.entries : [];
  const out: ReviewEntry[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    if (row.hidden === true || row.ignored === true || row.symlink === true) continue;
    const kind = row.kind === "dir" ? "dir" : row.kind === "file" ? "file" : null;
    if (!kind) continue;
    const name = typeof row.name === "string" ? row.name.slice(0, 255) : "";
    const path = typeof row.path === "string" ? safeReviewPath(row.path) : null;
    if (!name || !path) continue;
    out.push({ name, path, kind });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "en") : a.kind === "dir" ? -1 : 1));
}

/**
 * The "more rows" note for a listing page: set when the host says rows follow (`next_offset`), with the rows shown and
 * the host's total when it sent one. Null for a complete listing.
 */
export function listTruncation(body: unknown): { shown: number; total: number | null } | null {
  if (!isRecord(body) || typeof body.next_offset !== "number" || !Array.isArray(body.entries)) return null;
  return { shown: body.entries.length, total: typeof body.total === "number" ? body.total : null };
}

/** The reader's text from a `fs_read_file` result; null when it is binary/too large/unreadable. */
export function decodeFile(body: unknown): { text: string; bytes: number } | null {
  if (!isRecord(body) || body.status !== "ok" || typeof body.text !== "string") return null;
  return { text: body.text, bytes: typeof body.size === "number" ? body.size : body.text.length };
}

/** The Mac's empty hint, kept verbatim because it explains the workflow (compare code with LLM Doc via chat). */
export const REVIEW_EMPTY = {
  title: "Select a file to view",
  hint: "Import code or LLM Doc, then ask the assistant to compare them and flag conflicts or undecided items.",
} as const;

/** The Mac's EditorTabBar rule: after closing the active tab, the tab that slides into its slot, else the last. */
export function closeReviewTab(tabs: readonly string[], active: string | null, closing: string): { tabs: string[]; active: string | null } {
  const i = tabs.indexOf(closing);
  if (i < 0) return { tabs: [...tabs], active };
  const next = tabs.filter((t) => t !== closing);
  if (active !== closing) return { tabs: next, active };
  return { tabs: next, active: next[i] ?? next[i - 1] ?? null };
}

/** A folder's rows, or none when its listing fails. Used for first opens and for re-listing open folders on refresh. */
export async function readChildren(list: (path: string) => Promise<unknown>, path: string): Promise<ReviewEntry[]> {
  try {
    return decodeEntries(await list(path));
  } catch {
    return [];
  }
}

export interface SavedRepoLike {
  displayName: string;
  url: string;
  clonePath: string;
  active: boolean;
}

/** The linked repo as the Mac picks it: the active, cloned GitLab repo first, then GitHub. Null when none is linked. */
export function pickLinkedRepo(saved: { github: readonly SavedRepoLike[]; gitlab: readonly SavedRepoLike[] }): { label: string; path: string } | null {
  const pick = (rows: readonly SavedRepoLike[]) => rows.find((r) => r.active && r.clonePath.trim() !== "");
  const r = pick(saved.gitlab) ?? pick(saved.github);
  return r ? { label: r.displayName || r.url, path: r.clonePath } : null;
}

/**
 * The child listings to keep after a refresh: one entry per folder that is open at commit time. A folder re-listed
 * by the refresh takes the fresh rows; a folder opened while the refresh was running keeps the rows its own open
 * fetched (`previous`), so it is never shown open and empty. A folder that was closed meanwhile is dropped.
 */
export function openFolderChildren(
  openPaths: Iterable<string>,
  fresh: ReadonlyMap<string, readonly ReviewEntry[]>,
  previous: ReadonlyMap<string, readonly ReviewEntry[]>,
): Map<string, ReviewEntry[]> {
  const out = new Map<string, ReviewEntry[]>();
  for (const p of openPaths) {
    const rows = fresh.get(p) ?? previous.get(p);
    if (rows) out.set(p, [...rows]);
  }
  return out;
}

/**
 * Latest-wins guard for overlapping refreshes: `begin()` returns a token, and only the most recent token is
 * current, so an older refresh that finishes last cannot commit stale roots or folder rows over a newer one.
 */
export function refreshGate(): { begin: () => number; isCurrent: (token: number) => boolean } {
  let latest = 0;
  return { begin: () => ++latest, isCurrent: (token) => token === latest };
}
