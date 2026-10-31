// Small shared helpers for source notes: local date parts and slugs. Pure.
export { slugify } from "../write/note-ops.ts";

const p2 = (n: number): string => String(n).padStart(2, "0");

export function fmtDay(ms: number): { year: string; month: string; day: string; hh: string; mm: string; ss: string } {
  const d = new Date(Number.isFinite(ms) ? ms : 0);
  return { year: String(d.getFullYear()).padStart(4, "0"), month: p2(d.getMonth() + 1), day: p2(d.getDate()), hh: p2(d.getHours()), mm: p2(d.getMinutes()), ss: p2(d.getSeconds()) };
}
