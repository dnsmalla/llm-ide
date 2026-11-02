// A relative age shared by always-compiled screens (Welcome). Lives in the shell, not in an excludable screen:
// Welcome is always compiled and must not pull in `issues/` (gantt_issues can be off). Issues has its own copy.
/**
 * A relative age as the Mac's RelativeDateTimeFormatter (.short, numeric) words it: the largest whole elapsed unit,
 * truncated — "1 day ago", "2 wk. ago", "3 mo. ago", "in 2 hr."; "" when the timestamp is missing or malformed.
 */
export function openedAgo(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const ms = t - now.getTime();
  const sign = ms < 0 ? -1 : 1;
  const sec = Math.floor(Math.abs(ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always", style: "short" });
  const days = Math.floor(sec / 86_400);
  const [n, unit]: [number, Intl.RelativeTimeFormatUnit] =
    sec < 60 ? [sec, "second"]
    : sec < 3_600 ? [Math.floor(sec / 60), "minute"]
    : sec < 86_400 ? [Math.floor(sec / 3_600), "hour"]
    : days < 7 ? [days, "day"]
    : days < 30 ? [Math.floor(days / 7), "week"]
    : days < 365 ? [Math.floor(days / 30), "month"]
    : [Math.floor(days / 365), "year"];
  return rtf.format(sign * n, unit);
}
