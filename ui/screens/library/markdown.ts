// Safe Markdown for notes (untrusted: fetched mail, Slack, documents, model output).
//
// Output is a small AST that React renders as elements, so text is always escaped and nothing here
// can produce markup:
//  - raw HTML is never interpreted (`<script>`, `<iframe>`, `<img onerror=...>` are shown as text);
//  - images are never loaded: an image becomes its alt text plus the target as plain text;
//  - a link is kept only when its target is on the allowlist (`classifyHref`): http(s) and mailto
//    go out through the host (never the webview), relative links to other notes stay inside the
//    notes folder, everything else (`javascript:`, `data:`, `vbscript:`, `file:`, `blob:`,
//    `tauri:`, protocol-relative, control-character tricks, `user:pass@` hosts) becomes text;
//  - bounded: input size, nesting depth, table size and inline work are capped, so a hostile
//    document cannot make the parser quadratic or the tree huge.
//
// Supported: ATX headings, paragraphs, fenced code, block quotes, bullet / ordered / task lists
// (nested), GFM tables, thematic breaks, `code`, **strong**, *emphasis*, ~~strike~~, [links](url),
// <autolinks> and bare http(s) URLs. Anything else renders as plain text.

export const MAX_INPUT_CHARS = 4 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_TABLE_COLS = 50;
const MAX_TABLE_ROWS = 5000;
/** Inline parsing is skipped beyond this many characters in one paragraph (shown as plain text). */
const MAX_INLINE_CHARS = 20_000;
const MAX_INLINE_DEPTH = 5;

export type LinkTarget = { kind: "external"; url: string } | { kind: "note"; rel: string } | null;

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "strong"; children: Inline[] }
  | { t: "em"; children: Inline[] }
  | { t: "del"; children: Inline[] }
  | { t: "link"; target: Exclude<LinkTarget, null>; children: Inline[] }
  /** An image is never fetched: alt text, then the target as plain text. */
  | { t: "image"; alt: string; src: string };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "heading"; level: number; children: Inline[]; id: string }
  | { t: "paragraph"; children: Inline[] }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; children: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { done: boolean | null; children: Block[] }[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

// ---- link policy ------------------------------------------------------------------------

const NOTE_EXT = /\.(md|markdown|txt)$/i;

/**
 * Decides what a link target may do. `baseRel` is the note's own path (for relative links).
 * Returns null for anything not allowed; the caller then renders the link text without a link.
 */
export function classifyHref(href: string, baseRel: string | null): LinkTarget {
  const h = href.trim();
  if (h === "" || h.length > 2048) return null;
  // Control characters and whitespace are how `java\tscript:` style bypasses are written.
  if (/[\u0000-\u0020\u007f-\u009f\u00ad\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/.test(h)) return null;
  if (/^https?:\/\//i.test(h)) {
    try {
      const u = new URL(h);
      if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.username || u.password) return null;
      if (isLocalHost(u.hostname)) return null;
      return { kind: "external", url: u.href };
    } catch {
      return null;
    }
  }
  if (/^mailto:[^\s<>]+$/i.test(h)) return { kind: "external", url: h };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return null; // any other scheme, incl. Windows drive paths
  if (h.startsWith("//") || h.startsWith("\\") || h.startsWith("#") || h.startsWith("?")) return null;
  if (baseRel === null) return null;
  return resolveNoteLink(baseRel, h);
}

/** Loopback and the app's own origins: a note must not be able to point a click at this computer's services. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("::ffff:127.");
}

/** Resolves a relative link against the note at `baseRel`; null when it leaves the notes folder or is not a note file. */
export function resolveNoteLink(baseRel: string, href: string): { kind: "note"; rel: string } | null {
  let path = href.split("#")[0]!.split("?")[0]!;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (path === "" || path.includes("\\") || path.includes("\0") || path.startsWith("/")) return null;
  const out = baseRel.split("/").slice(0, -1);
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  const rel = out.join("/");
  return rel !== "" && NOTE_EXT.test(rel) ? { kind: "note", rel } : null;
}

// ---- block parser -----------------------------------------------------------------------

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( {0,3})([-*+])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const TABLE_DELIM = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

export function parseMarkdown(src: string, opts: { baseRel?: string | null } = {}): Block[] {
  const text = (src.length > MAX_INPUT_CHARS ? src.slice(0, MAX_INPUT_CHARS) : src).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const ctx: Ctx = { baseRel: opts.baseRel ?? null, slugs: new Map() };
  return parseBlocks(text.split("\n"), 0, ctx);
}

interface Ctx {
  baseRel: string | null;
  slugs: Map<string, number>;
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || /^ {0,3}>/.test(line) || BULLET.test(line) || ORDERED.test(line);
}

function parseBlocks(lines: string[], depth: number, ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (depth >= MAX_DEPTH) {
      // Too deep: the rest is plain text, never more nesting.
      blocks.push({ t: "paragraph", children: [{ t: "text", text: lines.slice(i).join("\n") }] });
      break;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !closesFence(lines[i]!, marker)) {
        body.push(lines[i]!);
        i += 1;
      }
      if (i >= lines.length && body.length > 0 && body[body.length - 1] === "") body.pop(); // unclosed: drop the split's last empty line
      i += 1; // closing fence, or the end of the text
      blocks.push({ t: "code", lang: fence[3]!.slice(0, 32), text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const raw = heading[2] ?? "";
      blocks.push({ t: "heading", level: heading[1]!.length, children: parseInline(raw, ctx, 0), id: slugFor(raw, ctx) });
      i += 1;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ t: "hr" });
      i += 1;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (/^ {0,3}>/.test(lines[i]!) || !isBlockStart(lines[i]!))) {
        inner.push(lines[i]!.replace(/^ {0,3}> ?/, ""));
        i += 1;
      }
      blocks.push({ t: "quote", children: parseBlocks(inner, depth + 1, ctx) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const { block, next } = parseList(lines, i, depth, ctx);
      blocks.push(block);
      i = next;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]!);
      if (head.length === delim.length) {
        const cols = Math.min(head.length, MAX_TABLE_COLS);
        const align = delim.slice(0, cols).map((d): Align => {
          const l = d.startsWith(":");
          const r = d.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : null;
        });
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|") && rows.length < MAX_TABLE_ROWS) {
          const cells = splitRow(lines[i]!).slice(0, cols);
          while (cells.length < cols) cells.push("");
          rows.push(cells.map((c) => parseInline(c, ctx, 0)));
          i += 1;
        }
        blocks.push({ t: "table", align, head: head.slice(0, cols).map((c) => parseInline(c, ctx, 0)), rows });
        continue;
      }
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (para.length === 0 || !isBlockStart(lines[i]!))) {
      para.push(lines[i]!.trim());
      i += 1;
    }
    const joined = para.join("\n");
    blocks.push({ t: "paragraph", children: parseInline(joined, ctx, 0) });
  }
  return blocks;
}

function closesFence(line: string, marker: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return m !== null && m[1]![0] === marker[0] && m[1]!.length >= marker.length;
}

function slugFor(raw: string, ctx: Ctx): string {
  const base = raw.toLowerCase().replace(/[`*_~[\]()]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-").slice(0, 60) || "section";
  const n = ctx.slugs.get(base) ?? 0;
  ctx.slugs.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (c === "\\" && s[k + 1] === "|") {
      cur += "|";
      k += 1;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseList(lines: string[], start: number, depth: number, ctx: Ctx): { block: Extract<Block, { t: "list" }>; next: number } {
  const first = lines[start]!;
  const ordered = ORDERED.test(first);
  const startNum = ordered ? Number(ORDERED.exec(first)![2]) : 1;
  const items: { done: boolean | null; children: Block[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = ordered ? ORDERED.exec(line) : BULLET.exec(line);
    if (!m) break;
    const markerLen = m[0].length;
    const contentIndent = Math.max(2, markerLen);
    const itemLines: string[] = [line.slice(markerLen)];
    i += 1;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.trim() === "") {
        // A blank line stays in the item only when an indented line follows.
        const nxt = lines[i + 1];
        if (nxt !== undefined && /^( {2,}|\t)/.test(nxt) && nxt.trim() !== "") {
          itemLines.push("");
          i += 1;
          continue;
        }
        break;
      }
      if (/^( {2,}|\t)/.test(l)) {
        itemLines.push(l.replace(new RegExp(`^( {1,${contentIndent}}|\\t)`), ""));
        i += 1;
        continue;
      }
      if (!isBlockStart(l)) {
        itemLines.push(l.trim()); // lazy continuation of the item's paragraph
        i += 1;
        continue;
      }
      break;
    }
    let done: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/.exec(itemLines[0]!);
    if (task) {
      done = task[1] !== " ";
      itemLines[0] = itemLines[0]!.slice(task[0].length);
    }
    items.push({ done, children: parseBlocks(itemLines, depth + 1, ctx) });
    // A blank line between items keeps the list going when the next line is another item.
    while (i < lines.length && lines[i]!.trim() === "" && i + 1 < lines.length && (ordered ? ORDERED : BULLET).test(lines[i + 1]!)) i += 1;
  }
  return { block: { t: "list", ordered, start: startNum, items }, next: i };
}

// ---- inline parser ----------------------------------------------------------------------

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>\"'&";

export function parseInline(text: string, ctx: { baseRel: string | null }, depth: number): Inline[] {
  if (text.length > MAX_INLINE_CHARS) return [{ t: "text", text }];
  const out: Inline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") {
      out.push({ t: "text", text: buf });
      buf = "";
    }
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\" && i + 1 < text.length && ESCAPABLE.includes(text[i + 1]!)) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (c === "\n") {
      buf += " ";
      i += 1;
      continue;
    }
    if (c === "`") {
      let n = 1;
      while (text[i + n] === "`") n += 1;
      const close = findRun(text, "`", n, i + n);
      if (close >= 0) {
        flush();
        out.push({ t: "code", text: text.slice(i + n, close).replace(/^ (.*) $/s, "$1") });
        i = close + n;
        continue;
      }
      buf += "`".repeat(n);
      i += n;
      continue;
    }
    if (depth < MAX_INLINE_DEPTH && (c === "*" || c === "_" || c === "~")) {
      const double = text[i + 1] === c;
      const marker = c === "~" ? (double ? "~~" : "") : double ? c + c : c;
      if (marker !== "" && canOpen(text, i, marker.length)) {
        const close = findClose(text, marker, i + marker.length);
        if (close > i + marker.length) {
          flush();
          const children = parseInline(text.slice(i + marker.length, close), ctx, depth + 1);
          out.push({ t: c === "~" ? "del" : marker.length === 2 ? "strong" : "em", children });
          i = close + marker.length;
          continue;
        }
      }
    }
    if ((c === "[" || (c === "!" && text[i + 1] === "[")) && depth < MAX_INLINE_DEPTH) {
      const isImage = c === "!";
      const labelStart = i + (isImage ? 2 : 1);
      const labelEnd = matchBracket(text, labelStart - 1);
      if (labelEnd > 0 && text[labelEnd + 1] === "(") {
        const dest = readDest(text, labelEnd + 2);
        if (dest) {
          flush();
          const label = text.slice(labelStart, labelEnd);
          if (isImage) {
            out.push({ t: "image", alt: label.slice(0, 200), src: dest.url.slice(0, 500) });
          } else {
            const target = classifyHref(dest.url, ctx.baseRel);
            const children = parseInline(label, ctx, depth + 1);
            if (target) out.push({ t: "link", target, children });
            else out.push(...children);
          }
          i = dest.end;
          continue;
        }
      }
    }
    if (c === "<") {
      const m = /^<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*)>/.exec(text.slice(i, i + 2100));
      if (m) {
        const target = classifyHref(m[1]!, ctx.baseRel);
        flush();
        if (target) out.push({ t: "link", target, children: [{ t: "text", text: m[1]! }] });
        else out.push({ t: "text", text: m[0] });
        i += m[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(text.slice(i, i + 8)) && (i === 0 || /[\s([{>"']/.test(text[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(text.slice(i, i + 2100));
      if (m) {
        const url = m[0].replace(/[.,;:!?'")\]}]+$/, "");
        const target = classifyHref(url, ctx.baseRel);
        if (target) {
          flush();
          out.push({ t: "link", target, children: [{ t: "text", text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    buf += c;
    i += 1;
  }
  flush();
  return out.filter((n) => !(n.t === "text" && n.text === ""));
}

function findRun(text: string, ch: string, n: number, from: number): number {
  let i = from;
  while (i < text.length) {
    const at = text.indexOf(ch, i);
    if (at < 0) return -1;
    let len = 1;
    while (text[at + len] === ch) len += 1;
    if (len === n) return at;
    i = at + len;
  }
  return -1;
}

function canOpen(text: string, i: number, len: number): boolean {
  const after = text[i + len];
  if (after === undefined || /\s/.test(after)) return false;
  if (text[i] === "_") {
    const before = text[i - 1];
    if (before !== undefined && /[\p{L}\p{N}]/u.test(before)) return false; // snake_case stays text
  }
  return true;
}

function findClose(text: string, marker: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const at = text.indexOf(marker, i);
    if (at < 0) return -1;
    if (text[at - 1] === "\\") {
      i = at + 1;
      continue;
    }
    const before = text[at - 1];
    const after = text[at + marker.length];
    const afterOk = marker[0] !== "_" || after === undefined || !/[\p{L}\p{N}]/u.test(after);
    if (before !== undefined && !/\s/.test(before) && afterOk && text[at + marker.length] !== marker[0]) return at;
    i = at + marker.length;
  }
  return -1;
}

/** Index of the `]` matching the `[` at `open`, or -1 (one level of nesting, no escapes past it). */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 1000; i++) {
    const c = text[i]!;
    if (c === "\\") i += 1;
    else if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `(url "title")` after the label: returns the url and the index after `)`. */
function readDest(text: string, from: number): { url: string; end: number } | null {
  let i = from;
  while (text[i] === " ") i += 1;
  let url = "";
  if (text[i] === "<") {
    const close = text.indexOf(">", i);
    if (close < 0 || close - i > 2100) return null;
    url = text.slice(i + 1, close);
    i = close + 1;
  } else {
    let parens = 0;
    const s = i;
    while (i < text.length && i - s < 2100) {
      const c = text[i]!;
      if (c === " " || c === "\n" || c === "\t") break;
      if (c === "(") parens += 1;
      else if (c === ")") {
        if (parens === 0) break;
        parens -= 1;
      }
      i += 1;
    }
    url = text.slice(s, i);
  }
  while (text[i] === " ") i += 1;
  if (text[i] === '"' || text[i] === "'") {
    const q = text[i]!;
    const close = text.indexOf(q, i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (text[i] === " ") i += 1;
  }
  if (text[i] !== ")") return null;
  return { url, end: i + 1 };
}

/** Plain text of inline nodes (for aria labels and outlines). */
export function inlineText(nodes: readonly Inline[]): string {
  let s = "";
  for (const n of nodes) {
    if (n.t === "text" || n.t === "code") s += n.text;
    else if (n.t === "image") s += n.alt;
    else s += inlineText(n.children);
  }
  return s;
}

export interface OutlineItem {
  level: number;
  text: string;
  id: string;
}

export function outline(blocks: readonly Block[]): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const b of blocks) if (b.t === "heading" && out.length < 500) out.push({ level: b.level, text: inlineText(b.children), id: b.id });
  return out;
}
