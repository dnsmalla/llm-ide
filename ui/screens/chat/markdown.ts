// Safe markdown for model output: text -> AST only. The renderer (markdown.tsx) builds React
// elements from the AST, so there is no HTML string anywhere and model text cannot inject markup.
// Links are allowlisted (http, https, mailto); images are never fetched (alt text only); raw HTML
// is plain text. Covers paragraphs, headings, lists, fenced code, blockquote, tables, rules,
// and inline code / bold / italic / links.

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "p"; inlines: Inline[] }
  | { kind: "h"; level: number; inlines: Inline[] }
  | { kind: "ul" | "ol"; items: Inline[][] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "table"; head: Inline[][]; rows: Inline[][][] }
  | { kind: "hr" };

const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const MAX_URL = 2048;

/** The link target if it is safe to hand to the host opener, else null. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (!url || url.length > MAX_URL) return null;
  // Control characters, whitespace and backslashes are how scheme filters get bypassed.
  if (/[\u0000- \u007f-\u009f\\]/.test(url)) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.protocol !== "mailto:" && !parsed.hostname) return null;
  if (parsed.username || parsed.password) return null; // phishing shape: https://good.com@evil.com
  return parsed.href;
}

const MAX_INLINE_DEPTH = 3;
// Order matters: code first (its content is literal), then image, link, strong, em.
const INLINE_RE = /(`[^`\n]+`)|(!\[([^\]\n]*)\]\(([^)\s]*)\))|(\[([^\]\n]+)\]\(([^)\s]*)\))|(\*\*([^*\n]+)\*\*)|(__([^_\n]+)__)|(\*([^*\n]+)\*)|(\b_([^_\n]+)_\b)/g;

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (t: string) => { if (t) out.push({ kind: "text", text: t }); };
  for (const m of text.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    push(text.slice(last, at));
    last = at + m[0].length;
    if (m[1]) out.push({ kind: "code", text: m[1].slice(1, -1) });
    else if (m[2]) push(m[3] ? `[image: ${m[3]}]` : "[image]"); // never loaded
    else if (m[5]) {
      const href = safeHref(m[7] ?? "");
      const kids = depth < MAX_INLINE_DEPTH ? parseInline(m[6], depth + 1) : [{ kind: "text", text: m[6] } as Inline];
      if (href) out.push({ kind: "link", href, children: kids });
      else out.push(...kids); // unsafe target: keep the label, drop the link
    } else if (m[8] || m[10]) {
      const inner = m[9] ?? m[11];
      out.push({ kind: "strong", children: depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1) : [{ kind: "text", text: inner }] });
    } else {
      const inner = m[13] ?? m[15];
      out.push({ kind: "em", children: depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1) : [{ kind: "text", text: inner }] });
    }
  }
  push(text.slice(last));
  return out;
}

const FENCE_OPEN = /^\s{0,3}```\s*([\w+.#-]*)\s*$/;
const FENCE_CLOSE = /^\s{0,3}```\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const isTableStart = (lines: string[], i: number) =>
  i + 1 < lines.length && lines[i].includes("|") && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-");

function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  return FENCE_OPEN.test(line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line) || RULE.test(line) || isTableStart(lines, i);
}

/** Splits markdown into blocks. An unclosed fence runs to the end (a stream mid-code). */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ kind: "code", lang: fence[1], text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") { i += 1; continue; }
    if (RULE.test(line) && !BULLET.test(line)) { blocks.push({ kind: "hr" }); i += 1; continue; }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "h", level: heading[1].length, inlines: parseInline(heading[2]) }); i += 1; continue; }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]).map((c) => parseInline(c));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]).map((c) => parseInline(c)));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])?.[1] ?? ""); i += 1; }
      blocks.push({ kind: "quote", inlines: parseInline(body.join("\n")) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i])) { items.push(parseInline(re.exec(lines[i])?.[1] ?? "")); i += 1; }
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && (para.length === 0 || !isBlockStart(lines, i))) { para.push(lines[i]); i += 1; }
    blocks.push({ kind: "p", inlines: parseInline(para.join("\n")) });
  }
  return blocks;
}
