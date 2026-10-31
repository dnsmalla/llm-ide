// Untrusted text from plugins, catalog skills, notes and file names is shown as TEXT only (React escapes it) after
// this pass: control characters, bidi overrides/isolates, zero-width and line/paragraph separators are removed or
// turned into spaces, whitespace is collapsed, and the length is capped. Pure.

const BIDI_AND_INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\u061C\u180E\uFEFF￹-￻]/g;
const LINE_BREAKS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g;

/** One safe display line, at most `max` characters (an ellipsis marks a cut). */
export function safeLine(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  // Cut BEFORE the regex passes so a multi-megabyte value costs O(max), not O(size).
  const head = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const s = head.replace(BIDI_AND_INVISIBLE, "").replace(LINE_BREAKS, " ").replace(/\s{2,}/g, " ").trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…` : s;
}

/** A token that is inserted into the draft (command trigger, skill name, argument name): conservative charset. */
export function safeToken(value: unknown, max = 64): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(value) ? value : null;
}

/**
 * A skill or subagent name that is written into the model-facing directive ("Use the <name> skill:"). Ids only:
 * plugin free text (spaces, quotes, newlines, instructions) must never reach the prompt, so anything else is null.
 */
export function safeDirectiveName(value: unknown, max = 64): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value) ? value : null;
}

/** `<owner> · <description>` with an empty owner dropped (the Mac's `ownedDetail`). */
export function ownedDetail(owner: unknown, description: unknown, max = 200): string {
  const o = safeLine(owner, 60);
  const d = safeLine(description, max);
  return o ? (d ? `${o} · ${d}` : o) : d;
}
