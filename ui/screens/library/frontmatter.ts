// Frontmatter for note files: the header between the leading `---` fences. Pure (no I/O, no DOM).
//
// Conformance: `splitFrontmatter` mirrors `MarkdownFrontmatter.split` in the Mac app
// (mac/Sources/LlmIdeMac/Core/Notes/Models/MarkdownFrontmatter.swift), quirks included, and
// `parseHeader` reads what Yams writes for `MeetingFrontmatter` (single-quoted ISO dates,
// block lists `- Alice`, `tldr: []`) plus the hand-written forms the Mac reader accepts
// (double quotes with `\"` and `\\`). The shared fixtures are `fixtures/frontmatter.json`
// (append-only: a Mac behaviour that changes gets a new case, never an edit).
//
// Deliberately NOT a full YAML parser: flat `key: value` lines, scalar lists (block and flow)
// and block scalars. Nested maps and anchors are skipped (value `null`), never evaluated.
// Everything is bounded, so a hostile file cannot make this slow or large.

export type FmValue = string | string[] | null;
export type FmData = Record<string, FmValue>;

export interface ParsedNote {
  /** True when the text opened with a closed `---` fence (the Mac `split` succeeded). */
  hasFrontmatter: boolean;
  /** Header fields, first occurrence of a key wins. Null-prototype object. */
  data: FmData;
  body: string;
  /** The raw header text (truncated at HEADER_MAX_CHARS), for a "raw frontmatter" view. */
  header: string;
}

export const HEADER_MAX_CHARS = 64 * 1024;
export const MAX_KEYS = 500;
export const MAX_LIST_ITEMS = 1000;
export const MAX_VALUE_CHARS = 64 * 1024;

const newData = (): FmData => Object.create(null) as FmData;

/**
 * Splits `---\n<header>\n---<rest of fence line>\n<body>`. Returns null when the text does not
 * open with a fence or the fence is never closed (the caller then treats the whole text as body).
 * Mirrors the Mac: CRLF is normalised, the close is the first `\n---` (so `----` also closes),
 * the rest of the closing line is dropped, and blank lines after it are removed.
 */
export function splitFrontmatter(text: string): { header: string; body: string } | null {
  const normalized = text.includes("\r\n") ? text.replaceAll("\r\n", "\n") : text;
  if (!normalized.startsWith("---\n")) return null;
  const afterOpen = normalized.slice(4);
  const close = afterOpen.indexOf("\n---");
  if (close < 0) return null;
  const header = afterOpen.slice(0, close);
  const rest = afterOpen.slice(close + 4);
  const nl = rest.indexOf("\n");
  let body = nl >= 0 ? rest.slice(nl + 1) : "";
  let i = 0;
  while (i < body.length && body[i] === "\n") i += 1;
  body = body.slice(i);
  return { header, body };
}

export function parseNote(text: string): ParsedNote {
  const split = splitFrontmatter(text);
  if (!split) return { hasFrontmatter: false, data: newData(), body: text, header: "" };
  const header = clipAtLine(split.header, HEADER_MAX_CHARS);
  return { hasFrontmatter: true, data: parseHeader(header), body: split.body, header };
}

/**
 * Like `parseNote` for a file HEAD (the first few KB, possibly cut mid-header or mid-line): when the
 * fence is not closed inside the head, the complete header lines read so far are still parsed, so a
 * long header does not lose its title and platform. `body` is empty in that case.
 */
export function parseHead(head: string): ParsedNote {
  const full = parseNote(head);
  if (full.hasFrontmatter) return full;
  const text = head.includes("\r\n") ? head.replaceAll("\r\n", "\n") : head;
  if (!text.startsWith("---\n")) return full;
  const lines = text.slice(4).split("\n");
  lines.pop(); // the last line may be cut
  if (lines.some((l) => l.startsWith("---"))) return full; // a closed header the strict split refused: leave it
  const header = clipAtLine(lines.join("\n"), HEADER_MAX_CHARS);
  return { hasFrontmatter: true, data: parseHeader(header), body: "", header };
}

function clipAtLine(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf("\n", max);
  return s.slice(0, cut > 0 ? cut : max);
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:[ \t]+(.*))?$/;

/** Reads a header into key -> scalar | list | null. See the module comment for what is supported. */
export function parseHeader(header: string): FmData {
  const data = newData();
  const lines = header.split("\n");
  let keys = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i += 1;
    const m = KEY_LINE.exec(line.trimEnd());
    // Only top-level keys (no indentation); indented lines belong to a value handled below.
    if (!m || /^\s/.test(line)) continue;
    const key = m[1]!;
    const raw = (m[2] ?? "").trim();
    let value: FmValue;
    if (raw === "" || raw.startsWith("#")) {
      // Block list, nested map, or a genuinely empty value.
      const items: string[] = [];
      let sawNested = false;
      let sawList = false;
      while (i < lines.length) {
        const next = lines[i]!;
        if (next.trim() === "") {
          i += 1;
          continue;
        }
        const li = /^[ \t]*-(?:[ \t]+(.*))?$/.exec(next);
        if (li && !/^[A-Za-z_]/.test(next)) {
          sawList = true;
          if (items.length < MAX_LIST_ITEMS) items.push(parseScalarText((li[1] ?? "").trim()) ?? "");
          i += 1;
        } else if (/^[ \t]/.test(next)) {
          sawNested = true;
          i += 1;
        } else break;
      }
      value = sawList && !sawNested ? items : null;
    } else if (/^[|>][+-]?\d*$/.test(raw)) {
      const folded = raw[0] === ">";
      const chomp = raw.includes("-") ? "strip" : raw.includes("+") ? "keep" : "clip";
      const block: string[] = [];
      let indent = -1;
      while (i < lines.length) {
        const next = lines[i]!;
        if (next.trim() !== "") {
          const ind = next.length - next.trimStart().length;
          if (ind === 0) break;
          if (indent < 0) indent = ind;
          if (ind < indent) break;
        }
        block.push(next.trim() === "" ? "" : next.slice(Math.min(indent < 0 ? 0 : indent, next.length)));
        i += 1;
      }
      while (block.length && block[block.length - 1] === "") block.pop();
      let text = folded ? foldLines(block) : block.join("\n");
      if (chomp !== "strip" && block.length) text += "\n";
      value = text.slice(0, MAX_VALUE_CHARS);
    } else if (raw.startsWith("[")) {
      value = parseFlowList(raw);
    } else if (raw.startsWith("{")) {
      value = null; // flow map: unsupported
    } else {
      value = parseScalarText(raw);
    }
    if (!(key in data)) {
      if (keys >= MAX_KEYS) break;
      data[key] = value;
      keys += 1;
    }
  }
  return data;
}

function foldLines(block: string[]): string {
  let out = "";
  for (let k = 0; k < block.length; k++) {
    const l = block[k]!;
    if (l === "") out += "\n";
    else out += (out && !out.endsWith("\n") ? " " : "") + l;
  }
  return out;
}

/** A scalar token: quoted (double with escapes, single with '') or plain (comment stripped). `null`/`~` -> null. */
export function parseScalarText(raw: string): string | null {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return s === "" ? "" : null;
  if (s.startsWith('"')) {
    const end = closingQuote(s, '"');
    return unescapeDouble(end > 0 ? s.slice(1, end) : s.slice(1)).slice(0, MAX_VALUE_CHARS);
  }
  if (s.startsWith("'")) {
    const end = closingQuote(s, "'");
    return (end > 0 ? s.slice(1, end) : s.slice(1)).replaceAll("''", "'").slice(0, MAX_VALUE_CHARS);
  }
  const hash = s.search(/[ \t]#/);
  return (hash >= 0 ? s.slice(0, hash) : s).trimEnd().slice(0, MAX_VALUE_CHARS);
}

function closingQuote(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") {
      i += 1;
    } else if (s[i] === q) {
      if (q === "'" && s[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
  }
  return -1;
}

const SIMPLE_ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0", " ": " " };

function unescapeDouble(s: string): string {
  if (!s.includes("\\")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\" || i === s.length - 1) {
      out += c;
      continue;
    }
    const n = s[i + 1]!;
    if (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16));
      i += 5;
    } else if (n in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[n];
      i += 1;
    } else {
      out += c; // unknown escape: keep the backslash, like a plain scalar
    }
  }
  return out;
}

function parseFlowList(raw: string): string[] | null {
  const items: string[] = [];
  let i = 1;
  let cur = "";
  let closed = false;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '"' || c === "'") {
      const end = closingQuote(raw.slice(i), c);
      if (end < 0) return null;
      cur += raw.slice(i, i + end + 1);
      i += end + 1;
      continue;
    }
    if (c === "[" || c === "{") return null; // nested flow collection: unsupported
    if (c === "," || c === "]") {
      if (cur.trim() !== "" || c === ",") {
        if (items.length < MAX_LIST_ITEMS) items.push(parseScalarText(cur.trim()) ?? "");
      }
      cur = "";
      if (c === "]") {
        closed = true;
        break;
      }
    } else cur += c;
    i += 1;
  }
  return closed ? items : null;
}

// ---- typed accessors --------------------------------------------------------------------

export function fmString(data: FmData, key: string): string | null {
  const v = data[key];
  if (typeof v === "string") return v.trim() === "" ? null : v;
  return null;
}

export function fmList(data: FmData, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v.filter((s) => s.trim() !== "");
  if (typeof v === "string" && v.trim() !== "") return [v];
  return [];
}

export function fmInt(data: FmData, key: string): number | null {
  const v = fmString(data, key);
  if (v === null || !/^-?\d+$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

/** ISO 8601 string or a Unix timestamp in seconds (the Mac accepts both). Milliseconds, or null. */
export function fmDateMs(data: FmData, key: string): number | null {
  const v = fmString(data, key)?.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (/^\d+(\.\d+)?$/.test(v)) {
    const sec = Number(v);
    return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
  }
  return null;
}
