// Untrusted-text handling for the Extensions screen. Every string that came from an item, an index,
// a scan finding or a diff is attacker-influenced (a repository author wrote it): it is rendered as
// text only, with control and bidirectional-override characters removed and a hard size cap.

// C0/C1 controls, DEL, bidi marks and overrides/isolates, zero-width and word-joiner characters, BOM,
// line and paragraph separators. Tab/newline/CR are controls too: single-line fields get a space instead.
const UNSAFE = new RegExp("[" + ["\\u0000-\\u001f", "\\u007f-\\u009f", "\\u061c", "\\u200b-\\u200f", "\\u2028-\\u202e", "\\u2060-\\u2069", "\\ufeff"].join("") + "]", "g");

/** Removes unsafe characters (a space for whitespace controls), collapses runs of spaces, caps the length. */
export function cleanText(value: unknown, max = 300): string {
  if (typeof value !== "string") return "";
  const s = value.replace(UNSAFE, (c) => (c === "\n" || c === "\r" || c === "\t" ? " " : "")).replace(/ {2,}/g, " ").trim();
  return capChars(s, max);
}

/** Cap by code points (never splits a surrogate pair); adds an ellipsis when cut. */
export function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, Math.max(0, max - 1)).join("") + "…";
}

/** True when the string holds a character `cleanText` would remove (used to refuse ids, never to edit them). */
export function hasUnsafeChars(s: string): boolean {
  UNSAFE.lastIndex = 0;
  return UNSAFE.test(s);
}

export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const isCommit = (s: unknown): s is string => typeof s === "string" && COMMIT_RE.test(s);
export const shortCommit = (c: string): string => c.slice(0, 8);
