// The one rule for a file or folder name typed by the user. Each caller maps the reason to its own sentence.

/** Every Unicode line terminator: a pasted wrapped line is invisible in a one-line field. */
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;

export type EntryNameProblem = "empty" | "dot" | "separator" | "null" | "line_break";

/**
 * Why a name cannot be used, or null. The name is judged after trimming. `/` and the null character are always
 * refused; `\` only when `refuseBackslash` (a local name must work on Windows, a POSIX server name need not).
 * Order of checks is the order callers report: empty, dot, separator, null, line break.
 */
export function entryNameProblem(raw: string, opts: { refuseBackslash?: boolean } = {}): EntryNameProblem | null {
  const name = raw.trim();
  if (name.length === 0) return "empty";
  if (name === "." || name === "..") return "dot";
  if (name.includes("/") || (opts.refuseBackslash === true && name.includes("\\"))) return "separator";
  if (name.includes("\0")) return "null";
  if (LINE_BREAK.test(name)) return "line_break";
  return null;
}
