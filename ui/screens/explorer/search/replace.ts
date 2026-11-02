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

/**
 * Replace every match, returning the new text and the number of replacements (`String.replace` callbacks).
 * Defaults to a regex template, as before; a literal (non-regex) query replaces with the text exactly, so a `$` is
 * not expanded, and `preserveCase` adjusts the case of each replacement to its match.
 */
export function replaceAll(text: string, re: RegExp, replacement: string, mode: ReplaceMode = { regex: true, preserveCase: false }): { text: string; count: number } {
  let count = 0;
  const next = text.replace(re, (...args) => {
    count++;
    if (!mode.regex) return mode.preserveCase ? preserveCaseReplacement(String(args[0]), replacement) : replacement;
    // Expand `$&`, `$1`… like String.replace does for a string replacement.
    return replacement.replace(/\$(\$|&|\d{1,2})/g, (_m, tok: string) => {
      if (tok === "$") return "$";
      if (tok === "&") return String(args[0]);
      const i = Number(tok);
      return i > 0 && i < args.length - 2 ? String(args[i] ?? "") : `$${tok}`;
    });
  });
  return { text: next, count };
}
