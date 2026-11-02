// Replace support for the project search: the SAME query/options semantics as the search host for literal and
// regex queries. Pure, so the rules are testable without the host.
import type { SearchOptions } from "./model";

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
function renderMatch(args: unknown[], replacement: string, mode: ReplaceMode): string {
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
function* hostLines(text: string): Generator<{ start: number; end: number; next: number }> {
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
    const sticky = new RegExp(re.source, re.flags.replace("g", "") + "y");
    sticky.lastIndex = at;
    const m = sticky.exec(lineText);
    if (!m || m[0] === "") return null;
    const args: unknown[] = [...m, m.index, lineText];
    if (m.groups) args.push(m.groups);
    const offset = l.start + at;
    return text.slice(0, offset) + renderMatch(args, replacement, mode) + text.slice(offset + m[0].length);
  }
  return null;
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
