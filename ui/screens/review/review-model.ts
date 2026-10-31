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
