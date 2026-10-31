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
// Every group has a bounded window, so a failed attempt at an unmatched opener costs O(window), never O(line). Order
// matters: code first (its content is literal), then image, link, strong, em.
const INLINE_RE = /(`[^`\n]{1,2000}`)|(!\[([^\]\n]{0,300})\]\(([^)\s]{0,2048})\))|(\[([^\]\n]{1,300})\]\(([^)\s]{0,2048})\))|(\*\*([^*\n]{1,600})\*\*)|(__([^_\n]{1,600})__)|(\*([^*\n]{1,600})\*)|(\b_([^_\n]{1,600})_\b)/g;

/**
 * Work budget of one parse: the number of opener characters (`[`, `*`, `_`, backtick) that may be tried against the
 * inline pattern. Each costs at most a few thousand steps, so the total is bounded no matter how hostile the text; once
 * spent, the rest is plain text (no formatting, nothing unsafe: plain text is never interpreted).
 */
export const INLINE_OPENER_BUDGET = 3_000;
export interface ParseBudget { openers: number }

function countOpeners(text: string, limit: number): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 91 || c === 42 || c === 95 || c === 96) { if (++n > limit) return n; }
  }
  return n;
}

export function parseInline(text: string, depth = 0, budget: ParseBudget = { openers: INLINE_OPENER_BUDGET }): Inline[] {
  const need = countOpeners(text, budget.openers);
  if (need > budget.openers) { budget.openers = 0; return text ? [{ kind: "text", text }] : []; }
  budget.openers -= need;
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
      const kids = depth < MAX_INLINE_DEPTH ? parseInline(m[6], depth + 1, budget) : [{ kind: "text", text: m[6] } as Inline];
      if (href) out.push({ kind: "link", href, children: kids });
      else out.push(...kids); // unsafe target: keep the label, drop the link
    } else if (m[8] || m[10]) {
      const inner = m[9] ?? m[11];
      out.push({ kind: "strong", children: depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1, budget) : [{ kind: "text", text: inner }] });
    } else {
      const inner = m[13] ?? m[15];
      out.push({ kind: "em", children: depth < MAX_INLINE_DEPTH ? parseInline(inner, depth + 1, budget) : [{ kind: "text", text: inner }] });
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
/** Lines longer than this are never block syntax (fence, rule, table): the patterns below only see short lines. */
export const MAX_SYNTAX_LINE = 2000;
const short = (re: RegExp, line: string): boolean => line.length <= MAX_SYNTAX_LINE && re.test(line);
const shortExec = (re: RegExp, line: string): RegExpExecArray | null => (line.length <= MAX_SYNTAX_LINE ? re.exec(line) : null);

/** `| --- | :-: |` without a nested-quantifier pattern: split on `|`, every cell is dashes with optional colons. */
const SEP_CELL = /^:?-+:?$/;
export function isTableSep(line: string): boolean {
  if (line.length > MAX_SYNTAX_LINE || !line.includes("-")) return false;
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  if (s === "") return false;
  for (const cell of s.split("|")) if (!SEP_CELL.test(cell.trim())) return false;
  return true;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

const isTableStart = (lines: string[], i: number) =>
  i + 1 < lines.length && lines[i].length <= MAX_SYNTAX_LINE && lines[i].includes("|") && isTableSep(lines[i + 1]);

function isBlockStart(lines: string[], i: number): boolean {
  const line = lines[i];
  return short(FENCE_OPEN, line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line) || short(RULE, line) || isTableStart(lines, i);
}

/** Splits markdown into blocks. An unclosed fence runs to the end (a stream mid-code). */
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const budget: ParseBudget = { openers: INLINE_OPENER_BUDGET };
  const inl = (t: string) => parseInline(t, 0, budget);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = shortExec(FENCE_OPEN, line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !short(FENCE_CLOSE, lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      blocks.push({ kind: "code", lang: fence[1], text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") { i += 1; continue; }
    if (short(RULE, line) && !BULLET.test(line)) { blocks.push({ kind: "hr" }); i += 1; continue; }
    const heading = HEADING.exec(line);
    if (heading) { blocks.push({ kind: "h", level: heading[1].length, inlines: inl(heading[2]) }); i += 1; continue; }
    if (isTableStart(lines, i)) {
      const head = splitRow(lines[i]).map((c) => inl(c));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]).map((c) => inl(c)));
        i += 1;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) { body.push(QUOTE.exec(lines[i])?.[1] ?? ""); i += 1; }
      blocks.push({ kind: "quote", inlines: inl(body.join("\n")) });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line);
      const re = ordered ? ORDERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i])) { items.push(inl(re.exec(lines[i])?.[1] ?? "")); i += 1; }
      blocks.push({ kind: ordered ? "ol" : "ul", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && (para.length === 0 || !isBlockStart(lines, i))) { para.push(lines[i]); i += 1; }
    blocks.push({ kind: "p", inlines: inl(para.join("\n")) });
  }
  return blocks;
}
