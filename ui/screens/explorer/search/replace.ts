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

/** Replace every match, returning the new text and the number of replacements (`String.replace` callbacks). */
export function replaceAll(text: string, re: RegExp, replacement: string): { text: string; count: number } {
  let count = 0;
  const next = text.replace(re, (...args) => {
    count++;
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
