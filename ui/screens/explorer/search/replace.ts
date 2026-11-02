// Replace support for the project search: the SAME query/options semantics as the search host for literal and
// regex queries. Pure, so the rules are testable without the host.
import { visibleFiles, type FileHits, type Hit, type SearchOptions } from "./model";

export function buildReplacer(query: string, opts: SearchOptions): RegExp | null {
  if (query === "") return null;
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch {
    return null;
  }
}

/** How a replacement is applied: `regex` = the replacement is a template ($1, $&); otherwise it is literal. */
export interface ReplaceMode {
  regex: boolean;
  /** Match the case of each matched text (non-regex only, like the Mac). */
  preserveCase: boolean;
}

/**
 * The Mac's `preserveCaseReplacement`: an all-caps match gives an upper-case replacement; a capitalised match
 * capitalises the first letter of the replacement; anything else uses the replacement as written.
 */
export function preserveCaseReplacement(matched: string, replacement: string): string {
  const hasLetters = /\p{L}/u.test(matched);
  if (hasLetters && matched === matched.toUpperCase()) return replacement.toUpperCase();
  const first = Array.from(matched)[0] ?? "";
  const isUpper = first !== "" && first === first.toUpperCase() && first !== first.toLowerCase();
  if (isUpper && matched !== matched.toUpperCase()) {
    const head = Array.from(replacement)[0] ?? "";
    return head.toUpperCase() + replacement.slice(head.length);
  }
  return replacement;
}

/** Where a match starts: 1-based line and 1-based UTF-16 column, as the search host reports a hit. */
export type MatchPosition = (offset: number) => { line: number; col: number };

/**
 * A walker from match offsets to line/column. Offsets must be ascending (String.replace and exec both yield them so);
 * the walk is then linear over the text.
 */
export function positionWalker(text: string): MatchPosition {
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  return (offset) => {
    for (;;) {
      const nl = text.indexOf("\n", scanned);
      if (nl === -1 || nl >= offset) break;
      line++;
      lineStart = nl + 1;
      scanned = nl + 1;
    }
    return { line, col: offset - lineStart + 1 };
  };
}

/** Number of trailing String.replace arguments after the captures: offset, string, and the groups object if any. */
function trailingCount(args: unknown[]): number {
  const last = args[args.length - 1];
  return typeof last === "object" && last !== null ? 3 : 2;
}

/** The text one match becomes. `args` is String.replace's argument list for that match. */
export function renderMatch(args: unknown[], replacement: string, mode: ReplaceMode): string {
  if (!mode.regex) return mode.preserveCase ? preserveCaseReplacement(String(args[0]), replacement) : replacement;
  const captures = args.length - trailingCount(args) - 1;
  // Expand `$&`, `$1`… like String.replace does for a string replacement.
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_m, tok: string) => {
    if (tok === "$") return "$";
    if (tok === "&") return String(args[0]);
    const i = Number(tok);
    return i > 0 && i <= captures ? String(args[i] ?? "") : `$${tok}`;
  });
}

/**
 * The lines exactly as the search host scans them (Rust `str::lines`): split on LF, a CR before the LF is not part
 * of the line. `start`/`end` bound the line's text; `next` is where the following line starts (or -1 for the last).
 */
export function* hostLines(text: string): Generator<{ start: number; end: number; next: number }> {
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      yield { start, end: text.length, next: -1 };
      return;
    }
    yield { start, end: nl > start && text[nl - 1] === "\r" ? nl - 1 : nl, next: nl + 1 };
    start = nl + 1;
  }
}

/**
 * Replace every match, returning the new text and the number of replacements. Defaults to a regex template, as
 * before; a literal (non-regex) query replaces with the text exactly, so a `$` is not expanded, and `preserveCase`
 * adjusts the case of each replacement to its match. `skip(line, col)` leaves a match untouched and uncounted (the
 * dismissed matches, which Replace All must not change).
 *
 * Matching is LINE BY LINE, exactly as the search host matches (and as the Mac's `SearchEngine.replacingAll`): a
 * pattern never spans a newline, `^`/`$` anchor at each line, and empty matches are left alone (the host never lists
 * them). Replace must change exactly what the results listed.
 */
export function replaceAll(
  text: string,
  re: RegExp,
  replacement: string,
  mode: ReplaceMode = { regex: true, preserveCase: false },
  skip?: (line: number, col: number) => boolean,
): { text: string; count: number } {
  let count = 0;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: string[] = [];
  let lineNo = 0;
  for (const l of hostLines(text)) {
    lineNo++;
    out.push(text.slice(l.start, l.end).replace(g, (...args: unknown[]) => {
      const matched = String(args[0]);
      if (matched === "") return matched;
      const offset = Number(args[args.length - trailingCount(args)]);
      if (skip && skip(lineNo, offset + 1)) return matched;
      count++;
      return renderMatch(args, replacement, mode);
    }));
    if (l.next !== -1) out.push(text.slice(l.end, l.next));
  }
  return { text: out.join(""), count };
}

/**
 * The match that starts at `at` (a UTF-16 index into `lineText`), matched on the line alone as the host matched it.
 * `args` is String.replace's argument list for that match. Null when no non-empty match starts there.
 */
function matchAt(lineText: string, re: RegExp, at: number): { text: string; args: unknown[] } | null {
  const sticky = new RegExp(re.source, re.flags.replace("g", "") + "y");
  sticky.lastIndex = at;
  const m = sticky.exec(lineText);
  if (!m || m[0] === "") return null;
  const args: unknown[] = [...m, m.index, lineText];
  if (m.groups) args.push(m.groups);
  return { text: m[0], args };
}

/**
 * Replace the ONE match that starts at 1-based `line` and UTF-16 `col`. The match must still be there: a sticky
 * regex at that exact position OF THAT LINE must match the query (matched within the line, as the host matched it,
 * so it never reaches into the next line). Returns null when it is not (the file changed since the search).
 */
export function replaceOneAt(
  text: string,
  re: RegExp,
  line: number,
  col: number,
  replacement: string,
  mode: ReplaceMode = { regex: true, preserveCase: false },
): string | null {
  if (!Number.isInteger(line) || !Number.isInteger(col) || line < 1 || col < 1) return null;
  let n = 0;
  for (const l of hostLines(text)) {
    if (++n < line) continue;
    const lineText = text.slice(l.start, l.end);
    const at = col - 1;
    if (at > lineText.length) return null;
    const m = matchAt(lineText, re, at);
    if (!m) return null;
    const offset = l.start + at;
    return text.slice(0, offset) + renderMatch(m.args, replacement, mode) + text.slice(offset + m.text.length);
  }
  return null;
}

/** One match the search LISTED: its host line and column, and the text it matched. `clipped`: the preview ran out. */
export interface ListedMatch {
  line: number;
  col: number;
  matched: string;
  clipped: boolean;
}

/**
 * The host's preview window (desktop/src-tauri/src/project_search.rs PREVIEW_BYTES). A line up to this many UTF-8
 * bytes is shown whole; a longer one as a window that, when it cuts a match, ends at the last char boundary at or
 * below `start + PREVIEW_BYTES`, so a window that cuts a match is always more than PREVIEW_BYTES - 4 bytes long.
 */
const PREVIEW_BYTES = 500;

/**
 * A listed match from a search hit. The preview is the line, or a window of it for a long line. `clipped` only when
 * the match reaches the end of a full-size WINDOW: a match that merely ends a short line is the whole match, so the
 * file must still match exactly that text (not a longer one, e.g. `\w+` on a word that grew since the search).
 */
export function listedMatch(h: Pick<Hit, "line" | "col" | "preview" | "ms" | "me">): ListedMatch {
  const windowed = new TextEncoder().encode(h.preview).length > PREVIEW_BYTES - 4;
  return { line: h.line, col: h.col, matched: h.preview.slice(h.ms, h.me), clipped: windowed && h.me >= h.preview.length };
}

/** The Replace All targets: each listed file (with at least one hit) and its listed matches, dismissed ones left out. */
export interface ReplaceTarget {
  path: string;
  hits: ListedMatch[];
}

export function listedTargets(files: readonly FileHits[], dismissed: ReadonlySet<string>): ReplaceTarget[] {
  return visibleFiles(files, dismissed)
    .filter((f) => f.hits.length > 0)
    .map((f) => ({ path: f.path, hits: f.hits.map(listedMatch) }));
}

/**
 * Replace exactly the LISTED matches in `text`, at their listed positions. Each one must still read as listed: the
 * sticky match at its line and column (BOM-shifted on line 1) must be the listed text (a clipped preview only needs
 * the shown prefix). Any listed match that does not is a refusal, as is an overlap. Matches the search never listed
 * are left alone, even when the file now has more.
 */
export function replaceListed(
  text: string,
  re: RegExp,
  listed: readonly ListedMatch[],
  replacement: string,
  mode: ReplaceMode,
  bom: boolean,
): { ok: true; text: string; count: number } | { ok: false } {
  if (listed.length === 0) return { ok: true, text, count: 0 };
  const lines = [...hostLines(text)];
  const spans: { start: number; end: number; out: string }[] = [];
  for (const h of listed) {
    if (!Number.isInteger(h.line) || !Number.isInteger(h.col) || h.line < 1 || h.col < 1 || h.matched === "") return { ok: false };
    const l = lines[h.line - 1];
    if (!l) return { ok: false };
    const lineText = text.slice(l.start, l.end);
    const at = bomShift(h.line, h.col, bom) - 1;
    if (at < 0 || at > lineText.length) return { ok: false };
    const m = matchAt(lineText, re, at);
    if (!m) return { ok: false };
    const same = h.clipped ? m.text.startsWith(h.matched) : m.text === h.matched;
    if (!same) return { ok: false };
    const start = l.start + at;
    spans.push({ start, end: start + m.text.length, out: renderMatch(m.args, replacement, mode) });
  }
  spans.sort((a, b) => a.start - b.start);
  let out = "";
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) return { ok: false };
    out += text.slice(pos, s.start) + s.out;
    pos = s.end;
  }
  return { ok: true, text: out + text.slice(pos), count: spans.length };
}

/** The file access Replace All needs: the same fresh read the positions are checked on, and the CAS write. */
export interface ReplaceFs<E extends string = string> {
  read(path: string, maxBytes: number): Promise<{ status: string; text: string | null; hash: string | null; encoding: E; bom: boolean }>;
  write(path: string, text: string, opts: { encoding: E; bom: boolean; expected_hash: string }): Promise<unknown>;
}

export interface ReplaceAllSummary {
  /** Files written. */
  files: number;
  /** Matches replaced across the written files. */
  replacements: number;
  /** Files that could not be read or written for a reason other than a changed file. */
  failed: string[];
  /** Files refused because a listed match no longer reads as listed, or because the file changed on write. */
  changed: string[];
}

/**
 * Replace All over the listed targets. Each file is read fresh, its listed matches are checked and replaced, and the
 * write is compare-and-swap on that read's hash (never forced). A changed file is refused and reported; the others
 * still run.
 */
export async function replaceListedInFiles<E extends string>(
  fs: ReplaceFs<E>,
  re: RegExp,
  mode: ReplaceMode,
  targets: readonly ReplaceTarget[],
  replacement: string,
): Promise<ReplaceAllSummary> {
  const summary: ReplaceAllSummary = { files: 0, replacements: 0, failed: [], changed: [] };
  for (const t of targets) {
    if (t.hits.length === 0) continue;
    try {
      const read = await fs.read(t.path, 4_000_000);
      if (read.status !== "ok" || read.text === null || read.hash === null) {
        summary.failed.push(t.path);
        continue;
      }
      const r = replaceListed(read.text, re, t.hits, replacement, mode, read.bom && read.encoding === "utf-8");
      if (!r.ok) {
        summary.changed.push(t.path);
        continue;
      }
      await fs.write(t.path, r.text, { encoding: read.encoding, bom: read.bom, expected_hash: read.hash });
      summary.files++;
      summary.replacements += r.count;
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
      if (code === "conflict") summary.changed.push(t.path);
      else summary.failed.push(t.path);
    }
  }
  return summary;
}

/**
 * The column in the text `fs.read` returns for a column the search host reported. The host scans the raw bytes, so a
 * UTF-8 BOM is a character (U+FEFF) at the start of line 1; `fs.read` strips it. Line 1 is therefore one to the left.
 * `toHost` converts the other way (for the dismissed-match keys).
 */
export function bomShift(line: number, col: number, bom: boolean, toHost = false): number {
  if (!bom || line !== 1) return col;
  return toHost ? col + 1 : col - 1;
}
