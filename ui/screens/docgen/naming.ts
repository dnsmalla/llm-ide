// File naming for saved documents. Pure.

const RESERVED = new Set(["con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "lpt1", "lpt2", "lpt3"]);

/** A safe, readable file stem: lowercase ascii-ish, `-` separated, no path characters, never empty. */
export function slugify(raw: string, max = 60): string {
  const s = String(raw ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // keep letters/digits of any script, turn everything else (path separators, dots, control, emoji) into a dash
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  let out = Array.from(s).slice(0, max).join("").replace(/-+$/g, "");
  if (out === "" || RESERVED.has(out)) out = out === "" ? "document" : `${out}-doc`;
  return out;
}

/** `<stem>.md`, then `<stem>-2.md`, `<stem>-3.md`... (index 0 is the plain name). */
export function candidateName(stem: string, index: number): string {
  return index <= 0 ? `${stem}.md` : `${stem}-${index + 1}.md`;
}

/** Stem for a generated document: template name, else command name, else a generic word; with a date to keep history sortable. */
export function documentStem(opts: { templateName?: string | null; commandName?: string | null; date: Date }): string {
  const base = slugify(opts.templateName || opts.commandName || "document", 48);
  const d = opts.date;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/** Folder (project-relative) generated documents are saved in, for Doc Gen and Visual alike (the Mac default). */
export const GENERATED_DIR = "llm-doc/generated";
