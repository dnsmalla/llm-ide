// Names and starting text for new, renamed and conflict-copy notes. Pure. The host re-validates every
// path (notes_write.rs); this module only produces good candidates and gives early, readable errors.

import { setKey } from "./frontmatter-edit.ts";

export const NOTE_EXTENSIONS = ["md", "markdown", "txt"] as const;
export const MAX_NAME_CHARS = 120;

/** File-name slug: lowercase letters and digits of any script, single dashes, bounded. */
export function slugify(s: string): string {
  const slug = s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "note" : slug;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export type NameProblem = "empty" | "too_long" | "bad_chars" | "hidden" | "extension" | "reserved";

/** Null when `name` is a good note file name (a single path segment ending in a note extension). */
export function nameProblem(name: string): NameProblem | null {
  if (name.trim() === "") return "empty";
  if (name.length > MAX_NAME_CHARS) return "too_long";
  // eslint-disable-next-line no-control-regex
  if (/[/\\:\u0000-\u001f\u007f<>"|?*]/.test(name) || name !== name.trim() || name.endsWith(".")) return "bad_chars";
  if (name.startsWith(".")) return "hidden";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!(NOTE_EXTENSIONS as readonly string[]).includes(ext) || name.toLowerCase().endsWith(".partial.md")) return "extension";
  if (WINDOWS_RESERVED.test(name.slice(0, dot))) return "reserved";
  return null;
}

export function nameProblemText(p: NameProblem): string {
  switch (p) {
    case "empty":
      return "Enter a name.";
    case "too_long":
      return `Use at most ${MAX_NAME_CHARS} characters.`;
    case "bad_chars":
      return "A name cannot contain slashes, colons, quotes, wildcard or control characters, or start or end with a space or end with a dot.";
    case "hidden":
      return "A name cannot start with a dot (hidden files are not part of the Library).";
    case "extension":
      return "End the name in .md, .markdown or .txt.";
    case "reserved":
      return "That name is reserved by Windows.";
  }
}

/** Adds `.md` when the user typed a bare name. */
export function withExtension(name: string): string {
  const t = name.trim();
  const dot = t.lastIndexOf(".");
  const ext = dot > 0 ? t.slice(dot + 1).toLowerCase() : "";
  return (NOTE_EXTENSIONS as readonly string[]).includes(ext) ? t : `${t}.md`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function dateStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Folder-relative path with a numeric suffix until `taken` says it is free. */
export function uniqueRel(folder: string, base: string, ext: string, taken: (rel: string) => boolean): string {
  const dir = folder === "" ? "" : `${folder.replace(/\/+$/, "")}/`;
  for (let i = 1; i < 1000; i++) {
    const rel = `${dir}${base}${i === 1 ? "" : `-${i}`}.${ext}`;
    if (!taken(rel)) return rel;
  }
  throw new RangeError("no free name");
}

/** `<folder>/<YYYY-MM-DD>-<slug>.md` for a new note. */
export function newNoteRel(folder: string, title: string, nowMs: number, taken: (rel: string) => boolean): string {
  return uniqueRel(folder, `${dateStamp(nowMs)}-${slugify(title)}`, "md", taken);
}

/** The text a new note starts with: a header with its title and creation time, then a heading. */
export function initialNoteText(title: string, nowMs: number): string {
  const t = title.trim() === "" ? "Untitled" : title.trim();
  let text = "---\n---\n\n";
  text = setKey(text, "title", t);
  text = setKey(text, "created_at", new Date(nowMs).toISOString());
  return `${text}# ${t.replace(/[\r\n]+/g, " ")}\n\n`;
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function baseOf(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

/** The new path for renaming `rel` to `newName` in the same folder. */
export function renamedRel(rel: string, newName: string): string {
  const dir = parentOf(rel);
  return dir === "" ? newName : `${dir}/${newName}`;
}

/** Where "Save my version as a copy" writes after a conflict. */
export function conflictCopyRel(rel: string, taken: (rel: string) => boolean): string {
  const name = baseOf(rel);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot + 1) : "md";
  return uniqueRel(parentOf(rel), `${stem} (conflict copy)`, ext, taken);
}
