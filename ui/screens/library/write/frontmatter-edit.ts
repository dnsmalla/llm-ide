// Surgical frontmatter edits: change one top-level key of a note's `---` header WITHOUT touching a
// single other byte. Pure (no I/O, no DOM).
//
// Why not parse -> modify -> serialise (what `FrontmatterCoder` does on the Mac for meeting files):
// the read-side parser (`../frontmatter.ts`) is deliberately partial (nested maps, anchors, comments
// and flow maps read as `null`), so re-serialising its result would DROP everything it cannot
// represent. Here the header is kept as raw lines; only the lines of the key being changed are
// replaced (or appended / removed). Unknown keys, their order, quoting, comments, blank lines, the
// closing-fence line and the body are byte-identical, and so is the file's line ending (CRLF files
// get CRLF in the new lines).
//
// The fence rules mirror `splitFrontmatter` (and the Mac `MarkdownFrontmatter.split`): the text must
// open with `---` + newline, and the header closes at the first `\n---` (so `----` also closes).
// A file without frontmatter gets one only when a key is SET.

import { parseHeader, type FmValue } from "../frontmatter.ts";

export type EditValue = string | readonly string[] | null;

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]|$)/;
const MAX_HEADER_BYTES = 256 * 1024;

interface Located {
  /** Index just after the opening fence line. */
  openEnd: number;
  /** Index of the closing fence line (the header region is `text.slice(openEnd, closeStart)`). */
  closeStart: number;
  eol: "\n" | "\r\n";
}

export function locateHeader(text: string): Located | null {
  const crlf = text.startsWith("---\r\n");
  if (!crlf && !text.startsWith("---\n")) return null;
  const openEnd = crlf ? 5 : 4;
  // An EMPTY header (`---\n---\n`): the closing fence is the very next line. Searching from openEnd for "\n---" would
  // skip it and close at a later `---` in the BODY, so a write would land in the body. (The Mac's
  // MarkdownFrontmatter.split has that quirk on the read side; the writer must not inherit it.)
  if (text.startsWith("---", openEnd)) return { openEnd, closeStart: openEnd, eol: crlf ? "\r\n" : "\n" };
  // Same quirk as the Mac: the close must be a "\n---" inside what follows the opening fence.
  const nl = text.indexOf("\n---", openEnd);
  if (nl < 0) return null;
  const closeStart = nl + 1;
  if (closeStart < openEnd) return null;
  if (closeStart - openEnd > MAX_HEADER_BYTES) return null;
  // The file's line ending: CRLF when the fence line uses it, else LF.
  return { openEnd, closeStart, eol: crlf ? "\r\n" : "\n" };
}

interface Line {
  /** Text without its line terminator. */
  text: string;
  /** The terminator exactly as in the file ("", "\n" or "\r\n"). */
  term: string;
}

function splitLines(region: string): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < region.length) {
    const nl = region.indexOf("\n", i);
    if (nl < 0) {
      out.push({ text: region.slice(i), term: "" });
      break;
    }
    const crlf = nl > i && region[nl - 1] === "\r";
    out.push({ text: region.slice(i, crlf ? nl - 1 : nl), term: crlf ? "\r\n" : "\n" });
    i = nl + 1;
  }
  return out;
}

const isContinuation = (l: string): boolean => /^[ \t]/.test(l) || /^-(?:[ \t]|$)/.test(l);

/** `[start, end)` line indexes of the block of the FIRST top-level `key` (key line + its continuation lines). */
function findBlock(lines: Line[], key: string): [number, number] | null {
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i]!.text);
    if (!m || m[1] !== key || /^[ \t]/.test(lines[i]!.text)) continue;
    let end = i + 1;
    let probe = end;
    for (;;) {
      while (probe < lines.length && lines[probe]!.text.trim() === "") probe += 1;
      if (probe < lines.length && isContinuation(lines[probe]!.text) && !KEY_LINE.test(lines[probe]!.text)) {
        end = probe + 1;
        probe = end;
      } else break;
    }
    return [i, end];
  }
  return null;
}

// ---- value serialisation ---------------------------------------------------------------------

/** Words YAML 1.1/1.2 would read as non-strings. */
const RESERVED = /^(?:~|null|true|false|yes|no|on|off|y|n)$/i;
const NUMBERISH = /^[-+]?(?:\d[\d_]*(?:\.\d*)?(?:e[-+]?\d+)?|\.\d+|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

function plainSafe(s: string): boolean {
  if (s === "" || s !== s.trim()) return false;
  if (RESERVED.test(s) || NUMBERISH.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false; // indicator first
  if (/: |:$| #|\t/.test(s) || s.includes("\n")) return false;
  // A date-looking plain scalar would be read as a timestamp by YAML; keep strings as strings.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false;
  return !CONTROL.test(s);
}

/** One scalar as YAML text: plain when unambiguous, else single-quoted, double-quoted when it has control characters. */
export function yamlScalar(s: string): string {
  if (plainSafe(s)) return s;
  if (CONTROL.test(s)) {
    let out = '"';
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (ch === "\n") out += "\\n";
      else if (ch === "\r") out += "\\r";
      else if (ch === "\t") out += "\\t";
      else if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) out += `\\u${c.toString(16).padStart(4, "0")}`;
      else out += ch;
    }
    return `${out}"`;
  }
  return `'${s.replaceAll("'", "''")}'`;
}

/** The lines (without terminators) for `key: value`. A list is the block form Yams writes (`- item`). */
export function renderBlock(key: string, value: EditValue): string[] {
  if (value === null) return [`${key}:`];
  if (typeof value === "string") return [`${key}: ${yamlScalar(value)}`];
  if (value.length === 0) return [`${key}: []`];
  return [`${key}:`, ...value.map((v) => `- ${yamlScalar(v)}`)];
}

/** A new note: a header of `fields` in order (lists as block lists), a blank line, then `body`. */
export function renderNote(fields: readonly (readonly [string, EditValue])[], body: string, eol: "\n" | "\r\n" = "\n"): string {
  const lines: string[] = [];
  for (const [k, v] of fields) {
    validKey(k);
    lines.push(...renderBlock(k, v));
  }
  const head = lines.length === 0 ? "" : lines.join(eol) + eol;
  return `---${eol}${head}---${eol}${eol}${body}`;
}

function validKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw new RangeError(`not a frontmatter key: ${key}`);
}

// ---- edits -----------------------------------------------------------------------------------

function applyToHeader(text: string, key: string, value: EditValue | undefined): string {
  validKey(key);
  const loc = locateHeader(text);
  const remove = value === undefined;
  if (!loc) {
    if (remove) return text;
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    return `---${eol}${renderBlock(key, value).join(eol)}${eol}---${eol}${eol}${text}`;
  }
  const region = text.slice(loc.openEnd, loc.closeStart);
  const lines = splitLines(region);
  const block = findBlock(lines, key);
  const eol = loc.eol;
  if (block) {
    const [s, e] = block;
    const lastTerm = lines[e - 1]!.term || eol;
    const fresh: Line[] = remove ? [] : renderBlock(key, value).map((t) => ({ text: t, term: eol }));
    if (fresh.length) fresh[fresh.length - 1]!.term = lastTerm;
    // Blank lines inside the old block (between its items) go with it; blanks after it stay.
    lines.splice(s, e - s, ...fresh);
  } else if (!remove) {
    // Append after the last non-blank header line so a trailing blank line stays last.
    let at = lines.length;
    while (at > 0 && lines[at - 1]!.text.trim() === "") at -= 1;
    if (at > 0 && lines[at - 1]!.term === "") lines[at - 1]!.term = eol;
    lines.splice(at, 0, ...renderBlock(key, value).map((t) => ({ text: t, term: eol })));
  } else {
    return text;
  }
  const next = lines.map((l) => l.text + l.term).join("");
  return text.slice(0, loc.openEnd) + next + text.slice(loc.closeStart);
}

/** Sets (or adds) one top-level key. A file with no frontmatter gets a new header. Other bytes are untouched. */
export function setKey(text: string, key: string, value: EditValue): string {
  return applyToHeader(text, key, value);
}

/** Removes one top-level key (its list items or block scalar lines too). A missing key returns `text` unchanged. */
export function removeKey(text: string, key: string): string {
  return applyToHeader(text, key, undefined);
}

/** The value `key` holds now, read with the same partial parser as the viewer. */
export function readKey(text: string, key: string): FmValue | undefined {
  const loc = locateHeader(text);
  if (!loc) return undefined;
  const data = parseHeader(text.slice(loc.openEnd, loc.closeStart).replaceAll("\r\n", "\n").replace(/\n$/, ""));
  return key in data ? data[key] : undefined;
}

function listOf(v: FmValue | undefined): string[] {
  if (Array.isArray(v)) return v.slice();
  if (typeof v === "string" && v.trim() !== "") return [v];
  return [];
}

export const MAX_TAG_CHARS = 64;

/** Tag text accepted for `tags`: trimmed, one line, no list/flow punctuation that would change meaning. */
export function normalizeTag(raw: string): string | null {
  const t = raw.replace(/\s+/g, " ").trim().replace(/^#/, "");
  if (t === "" || t.length > MAX_TAG_CHARS || CONTROL.test(t) || /[,[\]{}]/.test(t)) return null;
  return t;
}

/** Adds `tags` entries (case-insensitive de-dup, order kept). Returns the new text, or `text` when nothing changed. */
export function addTags(text: string, tags: readonly string[]): string {
  const have = listOf(readKey(text, "tags"));
  const seen = new Set(have.map((t) => t.toLowerCase()));
  const add: string[] = [];
  for (const raw of tags) {
    const t = normalizeTag(raw);
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      add.push(t);
    }
  }
  return add.length === 0 ? text : setKey(text, "tags", [...have, ...add]);
}

/** Removes `tags` entries (case-insensitive). An emptied list removes the key. */
export function removeTags(text: string, tags: readonly string[]): string {
  const have = listOf(readKey(text, "tags"));
  const drop = new Set(tags.map((t) => (normalizeTag(t) ?? t).toLowerCase()));
  const keep = have.filter((t) => !drop.has(t.toLowerCase()));
  if (keep.length === have.length) return text;
  return keep.length === 0 ? removeKey(text, "tags") : setKey(text, "tags", keep);
}
