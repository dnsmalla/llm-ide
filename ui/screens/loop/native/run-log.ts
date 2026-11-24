export const MAX_RUN_LOG_LINES = 2000;
export const TRIMMED_LINE = "… earlier output trimmed";

/** The last MAX_RUN_LOG_LINES lines; once any were dropped the first line says so (and counts toward the cap). */
export function capRunLog(lines: string[]): string[] {
  return lines.length <= MAX_RUN_LOG_LINES ? lines : [TRIMMED_LINE, ...lines.slice(-(MAX_RUN_LOG_LINES - 1))];
}
