// The loop cron schedule, run from the shell instead of the Loop page: one 30 s timer per app reads the open project's
// saved schedule and starts the loops marked "Run on schedule" through the run manager. Every call is injected, so node
// tests load this module without the shell. The stored format (`llmide.loopSchedule.v1.<root>`, `{cron,last}`) and the
// per-pass rules are the ones the page's own timer used.
import { isFactoryLoop } from "./factory.ts";
import { readSchedule, scheduleTick, type SavedSchedule } from "./schedule-tick.ts";
import type { LoopLoad } from "./store.ts";
import type { RunItem } from "./run-manager.ts";
import { loopRunItem } from "./run-manager.ts";

/** The Loop page shows a schedule line while it is open; with no page the line is dropped. */
export const SCHEDULE_NOTICE_EVENT = "llmide-loop-schedule-notice";
export const SCHEDULE_PASS_MS = 30_000;
export const scheduleKey = (projectRoot: string) => `llmide.loopSchedule.v1.${projectRoot}`;

const pageStarts = new Map<string, number>();

/**
 * Marks a Factory run the Loop page is starting or executing for `projectRoot`. Its start (approval dialog, worktree,
 * intake) happens before the run is visible to the run manager, so the schedule asks this too. Returns the release.
 */
export function markPageRun(projectRoot: string): () => void {
  pageStarts.set(projectRoot, (pageStarts.get(projectRoot) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const n = (pageStarts.get(projectRoot) ?? 1) - 1;
    if (n <= 0) pageStarts.delete(projectRoot); else pageStarts.set(projectRoot, n);
  };
}

export function pageRunStarting(projectRoot: string): boolean { return pageStarts.has(projectRoot); }

export interface ScheduleStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

export interface ScheduleDeps {
  now(): Date;
  storage: ScheduleStorage;
  /** The open project's root, or null when none is open. */
  projectRoot(): string | null;
  loadLoops(projectRoot: string): Promise<LoopLoad>;
  loopHasRun(projectRoot: string, loopId: string): boolean;
  /** True while a run of the project is executing (a loop run, or a run the Loop page itself is executing). */
  runActive(projectRoot: string): boolean;
  start(projectRoot: string, item: RunItem): void;
  /** A line for the Loop page's notice, when it is open. */
  tell(message: string): void;
  /** A line that outlives the Loop page, for a skipped scheduled run. */
  notify(message: string): void;
  valid(cron: string): boolean;
  matches(cron: string, now: Date): boolean;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  /** Calls `fn` when the open project changes; returns the unsubscribe. */
  onProjectChange(fn: () => void): () => void;
}

/** The project's saved schedule; anything unreadable is "no schedule". */
export function loadSchedule(storage: ScheduleStorage, projectRoot: string): SavedSchedule {
  try { return readSchedule(storage.getItem(scheduleKey(projectRoot))); } catch { return readSchedule(null); }
}

/** Saves the cron. The minute that already fired is kept while the cron is unchanged: saving it again must not fire it twice. */
export function saveSchedule(storage: ScheduleStorage, projectRoot: string, cron: string): void {
  const prev = loadSchedule(storage, projectRoot);
  try { storage.setItem(scheduleKey(projectRoot), JSON.stringify({ cron: cron.trim(), last: prev.cron === cron.trim() ? prev.last : "" })); } catch { /* session only */ }
}

/** One pass for one project: records the minute, and when the schedule fires starts every loop marked "Run on schedule". */
export async function schedulePass(d: ScheduleDeps): Promise<void> {
  const root = d.projectRoot();
  if (!root) return;
  const { fire, next } = scheduleTick(loadSchedule(d.storage, root), d.now(), d.valid, d.matches);
  if (next) { try { d.storage.setItem(scheduleKey(root), JSON.stringify(next)); } catch { /* session only */ } }
  if (!fire) return;
  const skip = (message: string) => { d.tell(message); d.notify(message); };
  let load: LoopLoad;
  // A switch while loop.json was read rejects the read (no_project); that schedule is simply no longer the open one.
  try { load = await d.loadLoops(root); } catch (e) { if (d.projectRoot() !== root) return; skip(`The schedule fired, but the loop file could not be read: ${e instanceof Error ? e.message : String(e)}`); return; }
  // The project was closed or switched while loop.json was read: this schedule is no longer the open one.
  if (d.projectRoot() !== root) return;
  if (load.kind === "corrupt") { skip(`The schedule fired, but the loop file could not be read: ${load.message}`); return; }
  const scheduled = (load.kind === "ok" ? load.store.loops : []).filter((l) => l.runsOnSchedule);
  if (scheduled.length === 0) { skip("The schedule fired, but no loop is marked Run on schedule."); return; }
  if (d.runActive(root)) { skip("The schedule fired while a run is active; scheduled loops were skipped."); return; }
  d.tell(`Schedule fired: running ${scheduled.length} loop(s).`);
  for (const l of scheduled) {
    if (isFactoryLoop(l)) { skip(`“${l.name}” is a Factory loop: start it with ▶ Run and pick a work item.`); continue; }
    if (l.config.workMode === "one") { skip(`“${l.name}” is set to one item you name; the schedule skipped it.`); continue; }
    if (d.loopHasRun(root, l.id)) { skip(`“${l.name}” already has a run in progress or queued.`); continue; }
    d.start(root, loopRunItem(l, { scheduled: true }));
  }
}

let stopCurrent: (() => void) | null = null;

/** Starts the app's one schedule timer (a second call replaces the first). Returns the stop. */
export function startLoopSchedule(d: ScheduleDeps): () => void {
  stopCurrent?.();
  const pass = () => { void schedulePass(d); };
  const timer = d.setInterval(pass, SCHEDULE_PASS_MS);
  const offProject = d.onProjectChange(pass);
  pass();
  const stop = () => {
    d.clearInterval(timer);
    offProject();
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;
  return stop;
}
