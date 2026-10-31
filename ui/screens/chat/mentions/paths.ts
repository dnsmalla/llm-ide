// Mention path rules. A mention names a file of the OPEN project, always project-relative with `/` separators.
// Resolution is confined to the project root: no absolute form, no drive letters, no `..`, no NUL, no backslash
// tricks, bounded length. The host fs commands confine again on their side (defence in depth); the webview never
// builds an absolute path.

export const MAX_MENTION_PATH = 1024;

/** The normalised project-relative path, or null when it is not a safe one. A trailing `/` is dropped. */
export function safeMentionPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_MENTION_PATH) return null;
  if (/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\uFEFF]/.test(raw)) return null;
  if (raw.includes("\\") || raw.startsWith("/") || raw.startsWith("~") || /^[A-Za-z]:/.test(raw)) return null;
  const parts: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue; // "a//b", "./a"
    if (seg === ".." ) return null;
    if (seg.length > 255) return null;
    parts.push(seg);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/** Splits an `@query` into a directory to browse and a name prefix: `src/ui/ch` -> { dir: "src/ui", prefix: "ch" }. */
export function splitQuery(query: string): { dir: string | null; prefix: string } {
  const i = query.lastIndexOf("/");
  if (i < 0) return { dir: null, prefix: query };
  const dirRaw = query.slice(0, i);
  if (dirRaw === "") return { dir: null, prefix: query.slice(i + 1) }; // "@/etc" never browses an absolute path
  return { dir: dirRaw, prefix: query.slice(i + 1) };
}

/** Directory names that are never scanned for the flat index (generated or vendored; typing a path still reaches them). */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".build", "DerivedData", "dist", "build", ".next", "Pods", "vendor", ".venv", "target", "__pycache__", ".cache", ".gradle",
]);
