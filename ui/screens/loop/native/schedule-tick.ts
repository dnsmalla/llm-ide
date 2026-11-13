// One pass of the Loop page's scheduler. The saved schedule is read again on every pass, so an edit or a cleared
// field takes effect on the next pass: the timer used to capture the cron it started with, kept firing on it after an
// edit, and wrote it back over the cleared value.

export interface SavedSchedule { cron: string; last: string }

/** The saved schedule from its stored JSON; anything unreadable is "no schedule". */
export function readSchedule(raw: string | null): SavedSchedule {
  try {
    const v = JSON.parse(raw ?? "{}") as { cron?: unknown; last?: unknown };
    return { cron: typeof v.cron === "string" ? v.cron.trim() : "", last: typeof v.last === "string" ? v.last : "" };
  } catch {
    return { cron: "", last: "" };
  }
}

const minuteKey = (now: Date) => `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

/**
 * Whether the schedule fires at `now`, and what to store afterwards. `next` is null when nothing changes; it never
 * carries a cron other than the one just read, so a pass cannot bring back a schedule the user removed.
 */
export function scheduleTick(saved: SavedSchedule, now: Date, valid: (cron: string) => boolean, matches: (cron: string, now: Date) => boolean): { fire: boolean; next: SavedSchedule | null } {
  if (!saved.cron || !valid(saved.cron)) return { fire: false, next: null };
  const minute = minuteKey(now);
  if (minute === saved.last || !matches(saved.cron, now)) return { fire: false, next: null };
  return { fire: true, next: { cron: saved.cron, last: minute } };
}
