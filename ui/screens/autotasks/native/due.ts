// Which scheduled Auto Tasks are due this minute. Pure: the page supplies the fired-minute store, so one task never runs
// twice in a minute, and a task due in the same minute as another is not dropped (the page queues all of them).
import { cronMatches, validateCron } from "./cron.ts";

export interface ScheduledCandidate<Id extends string = string> { id: Id; cron: string; allowed: boolean }

/** The `Y-M-D-H-m` key of the minute `now` falls in (the format the fired store has always used). */
export function minuteKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
}

/**
 * The candidates due at `now` that have not fired in this minute, in catalog order. Each returned id is marked fired
 * through `markFired` before it is returned. A candidate that is not allowed, has an invalid cron, or does not match
 * `now` is never returned and never marked.
 */
export function takeDueAutoTasks<Id extends string>(
  candidates: readonly ScheduledCandidate<Id>[],
  now: Date,
  hasFired: (key: string) => boolean,
  markFired: (key: string) => void,
): Id[] {
  const minute = minuteKey(now);
  const due: Id[] = [];
  for (const candidate of candidates) {
    if (!candidate.allowed || !validateCron(candidate.cron) || !cronMatches(candidate.cron, now)) continue;
    const key = `${candidate.id}:${minute}`;
    if (hasFired(key)) continue;
    markFired(key);
    due.push(candidate.id);
  }
  return due;
}
