// Friendly timestamps for list rows: "Today 18:30", "Yesterday 17:00", "Tuesday 09:15" within six days, else "Nov 10" (+ year when not this year).
// Uses the browser locale (Intl.DateTimeFormat). `fullDate` is the unabridged form for a title attribute.
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const DAY_MS = 86_400_000;

export function toDate(value: number | string | Date): Date | null {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fullDate(value: number | string | Date, locale?: string): string {
  const d = toDate(value);
  return d ? d.toLocaleString(locale) : String(value);
}

export function friendlyDate(value: number | string | Date, now: number | Date = Date.now(), locale?: string): string {
  const d = toDate(value);
  if (!d) return String(value);
  const today = startOfDay(now instanceof Date ? now : new Date(now));
  const days = Math.round((today - startOfDay(d)) / DAY_MS);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days <= 6) return `${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(d)} ${time}`;
  const sameYear = d.getFullYear() === new Date(today).getFullYear();
  return new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(d);
}
