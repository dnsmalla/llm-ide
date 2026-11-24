export const MAX_RUN_LOG_LINES = 2000;
export const MAX_RUN_LOG_LINE_CHARS = 4000;
export const TRIMMED_LINE = "… earlier output trimmed";

/** The last MAX_RUN_LOG_LINES lines; once any were dropped the first line says so (and counts toward the cap). */
export function capRunLog(lines: string[]): string[] {
  return lines.length <= MAX_RUN_LOG_LINES ? lines : [TRIMMED_LINE, ...lines.slice(-(MAX_RUN_LOG_LINES - 1))];
}

const capLine = (s: string): string => (s.length > MAX_RUN_LOG_LINE_CHARS ? `${s.slice(0, MAX_RUN_LOG_LINE_CHARS)}…` : s);

/** Streamed text: continues the last line up to its first "\\n", the rest become new lines; lines and count are capped. */
export function appendRunLog(lines: string[], text: string): string[] {
  const [first = "", ...more] = text.split("\n");
  const out = lines.length === 0 ? [capLine(first)] : [...lines.slice(0, -1), capLine(lines[lines.length - 1] + first)];
  for (const m of more) out.push(capLine(m));
  return capRunLog(out);
}
