// The Library's project-file categories: the Mac's Library shows Code and Data file trees beside the note sections
// (LibraryItem.Category.code/.data). The desktop reads those folders through the host's read-only fs commands; the
// notes sections keep using the notes index. Paths are project-relative and confined by the host.
export interface ProjectEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
}

export const PROJECT_ROOTS: readonly { path: string; label: string }[] = [
  { path: "code", label: "Code" },
  { path: "data", label: "Data" },
];

const MAX_ENTRIES = 500;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function safeProjectPath(path: string): string | null {
  const t = path.trim();
  if (!t || t.startsWith("/") || t.length > 1024 || /[\u0000-\u001f]/.test(t)) return null;
  const parts = t.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null;
  return parts.join("/");
}

/** `fs_list_dir` entries under one category: hidden/symlink/ignored dropped, dirs first, alpha. */
export function decodeProjectEntries(body: unknown): ProjectEntry[] {
  const list = isRecord(body) && Array.isArray(body.entries) ? body.entries : [];
  const out: ProjectEntry[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    if (row.hidden === true || row.ignored === true || row.symlink === true) continue;
    const kind = row.kind === "dir" ? "dir" : row.kind === "file" ? "file" : null;
    const name = typeof row.name === "string" ? row.name.slice(0, 255) : "";
    const path = typeof row.path === "string" ? safeProjectPath(row.path) : null;
    if (!kind || !name || !path) continue;
    out.push({ name, path, kind });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "en") : a.kind === "dir" ? -1 : 1));
}

/** A text read for the read-only viewer; null for binary/too-large. */
export function decodeProjectFile(body: unknown): { text: string; bytes: number } | null {
  if (!isRecord(body) || body.status !== "ok" || typeof body.text !== "string") return null;
  return { text: body.text, bytes: typeof body.size === "number" ? body.size : body.text.length };
}
