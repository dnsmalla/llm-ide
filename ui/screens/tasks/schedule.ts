// The one desktop scheduler (Task 15). A tick every 30 s for the open project decides which registry and custom tasks
// are due, runs them one at a time under the shared Auto Task lock, and records every slot, a skipped one with its
// reason included. Pure over injected clock, storage, lock and runner, so it runs without React or the host.
import { takeDueAutoTasks, type ScheduledCandidate } from "../autotasks/native/due.ts";
import { scheduledRunAllowed } from "../autotasks/native/model.ts";
import { customTaskRunnable, loadCustomTasks, normaliseProjectRoot, type CustomAutoTask } from "../autotasks/native/custom.ts";
import { validateCron } from "../autotasks/native/cron.ts";
import { TASKS } from "./registry.generated.ts";
import { loadTaskState, type TaskState } from "./store.ts";
import type { TaskEnv } from "./types.ts";

const FIRED_KEY = "llmide.tasks.v2.fired";
const MAX_FIRED = 200;
/** Outcomes recorded as a skipped slot, not a failure: the refusal is the answer, and no engine call was made. */
export const SKIP_CODES: ReadonlySet<string> = new Set(["USD_CAP", "PAUSED_BY_LIMITS", "NEEDS_APPROVAL", "WRITE_RUN_LIVE", "STOPPED"]);
const BUSY_SUMMARY = "Another Auto Task run was active (busy) for the whole catch-up time; this slot was skipped.";

export type ScheduledItem = { kind: "task"; id: string } | { kind: "custom"; task: CustomAutoTask };
export interface ScheduledOutcome { ok: boolean; summary: string; code?: string }
export interface ScheduledRecord { item: ScheduledItem; projectRoot: string; at: string; status: "ok" | "failed" | "skipped"; summary: string }

export interface SchedulerDeps {
  storage?: Storage;
  now(): Date;
  hasRepo(): boolean;
  /** A Factory or Loop run is writing in this project; a scheduled task waits for the next slot. */
  writeRunLive(projectRoot: string): boolean;
  /** The shared Auto Task lock: one run at a time across the page, the custom modal and this scheduler. */
  acquire(): boolean;
  release(): void;
  run(item: ScheduledItem, projectRoot: string): Promise<ScheduledOutcome>;
  record(record: ScheduledRecord): void;
  shouldStop?(): boolean;
  /** Fired marks that survive a failed write of the persisted list. Defaults to one set per scheduler module. */
  memory?: Set<string>;
  /** Slots that were due while the lock was taken and still wait for it. Defaults to one list per scheduler module. */
  waiting?: WaitingSlot[];
}

/** A due slot that found the Auto Task lock taken: it runs as soon as the lock is free, within the catch-up window. */
export interface WaitingSlot { item: ScheduledItem; projectRoot: string; dueAt: number }

/** How long a slot that found the lock taken keeps waiting for it before it is recorded as skipped. */
export const BUSY_CATCH_UP_MS = 10 * 60_000;
const MAX_WAITING = 50;

const moduleMemory = new Set<string>();
const moduleWaiting: WaitingSlot[] = [];

/** App-scoped tasks (`sources.update`, `plan.status`) are one key for every project: they run once, not per project. */
const fireKey = (root: string, scope: "project" | "app", id: string): string => (scope === "app" ? id : `${root}|${id}`);

/**
 * Registry tasks due at `now`, in catalog order. Each one is marked in `fired` for this minute. A task with no desktop
 * schedule (`backend: "none"`, D17) is never returned, whatever its stored config says.
 */
export function dueTasks(state: TaskState, now: Date, fired: Set<string>, env: TaskEnv, projectRoot: string): string[] {
  if (!state.masterEnabled) return [];
  const byKey = new Map<string, string>();
  const candidates: ScheduledCandidate<string>[] = [];
  for (const t of TASKS) {
    if (t.availability.status !== "available" || t.schedule.backend !== "desktop") continue;
    const key = fireKey(projectRoot, t.scope, t.id);
    const c = state.configs[t.id];
    byKey.set(key, t.id);
    candidates.push({ id: key, cron: c?.cron ?? "", allowed: scheduledRunAllowed(t.id, c, env.hasRepo, env) });
  }
  return takeDueAutoTasks(candidates, now, (k) => fired.has(k), (k) => { fired.add(k); }).map((k) => byKey.get(k) ?? k);
}

/** Custom tasks due at `now`, in list order, marked in `fired` like the registry tasks. */
export function dueCustomTasks(tasks: readonly CustomAutoTask[], masterEnabled: boolean, now: Date, fired: Set<string>, projectRoot: string): CustomAutoTask[] {
  if (!masterEnabled) return [];
  const byKey = new Map<string, CustomAutoTask>();
  const candidates: ScheduledCandidate<string>[] = tasks.map((task) => {
    const key = fireKey(projectRoot, "project", task.id);
    byKey.set(key, task);
    return { id: key, cron: task.cron, allowed: customTaskRunnable(task) && task.enabled && task.cron !== "" && validateCron(task.cron) };
  });
  return takeDueAutoTasks(candidates, now, (k) => fired.has(k), (k) => { fired.add(k); }).flatMap((k) => byKey.get(k) ?? []);
}

function loadFired(storage: Storage, memory: Set<string>): Set<string> {
  let persisted: string[] = [];
  try {
    const v = JSON.parse(storage.getItem(FIRED_KEY) ?? "[]") as unknown;
    if (Array.isArray(v)) persisted = v.filter((k): k is string => typeof k === "string");
  } catch { /* an unreadable list is the same as none; the memory below still dedupes */ }
  return new Set([...persisted, ...memory]);
}

function saveFired(storage: Storage, fired: Set<string>, memory: Set<string>): void {
  const keys = [...fired].slice(-MAX_FIRED);
  for (const k of keys) memory.add(k);
  while (memory.size > MAX_FIRED) memory.delete(memory.values().next().value as string);
  try { storage.setItem(FIRED_KEY, JSON.stringify(keys)); } catch { /* the memory still dedupes this session */ }
}

async function runOne(item: ScheduledItem, root: string, deps: SchedulerDeps): Promise<ScheduledOutcome> {
  if (deps.writeRunLive(root)) return { ok: false, code: "WRITE_RUN_LIVE", summary: "A Factory or Loop run is writing in this project; this slot was skipped." };
  try { return await deps.run(item, root); } catch (e) { return { ok: false, summary: e instanceof Error ? e.message : "The task could not run." }; }
}

/** The slots due now for `root`, already marked fired and saved (so a crash or a busy lock never fires one twice). */
function takeDueItems(root: string, deps: SchedulerDeps): ScheduledItem[] {
  const storage = deps.storage ?? globalThis.localStorage;
  const memory = deps.memory ?? moduleMemory;
  const state = loadTaskState(root, storage);
  if (!state.masterEnabled) return [];
  const now = deps.now();
  const env: TaskEnv = { features: null, coreFeatures: null, hasRepo: deps.hasRepo(), localHost: true, mode: "local" };
  const fired = loadFired(storage, memory);
  const items: ScheduledItem[] = [
    ...dueTasks(state, now, fired, env, root).map((id): ScheduledItem => ({ kind: "task", id })),
    ...dueCustomTasks(loadCustomTasks(root, storage), state.masterEnabled, now, fired, root).map((task): ScheduledItem => ({ kind: "custom", task })),
  ];
  // Marks are saved before anything runs, so a crash mid-run does not fire the same slot again.
  saveFired(storage, fired, memory);
  return items;
}

/**
 * One scheduler pass for `projectRoot`. Returns how many slots were started or recorded as skipped.
 *
 * Due matching is exact to the minute, so a slot that finds the Auto Task lock taken cannot simply be left for the
 * next pass: once its minute is over it would vanish without a record. It cannot be dropped at once either: a manual
 * run of a few seconds at 02:00 would then cost the whole day's 02:00 task. So such a slot waits. It is marked fired
 * (it can never start twice), runs on the first pass that finds the lock free, and is recorded as skipped only when
 * the lock stayed taken for the whole catch-up window.
 */
export async function runDueScheduled(projectRoot: string, deps: SchedulerDeps): Promise<number> {
  const root = normaliseProjectRoot(projectRoot);
  if (!root) return 0;
  const waiting = deps.waiting ?? moduleWaiting;
  const nowMs = deps.now().getTime();
  let counted = 0;
  // Slots that waited too long are given up, with a record that says why.
  for (let i = waiting.length - 1; i >= 0; i--) {
    const w = waiting[i]!;
    if (w.projectRoot !== root || nowMs - w.dueAt <= BUSY_CATCH_UP_MS) continue;
    waiting.splice(i, 1);
    deps.record({ item: w.item, projectRoot: root, at: new Date(w.dueAt).toISOString(), status: "skipped", summary: BUSY_SUMMARY });
    counted++;
  }
  const fresh = takeDueItems(root, deps);
  const mine = waiting.filter((w) => w.projectRoot === root);
  if (fresh.length === 0 && mine.length === 0) return counted;
  if (!deps.acquire()) {
    for (const item of fresh) waiting.push({ item, projectRoot: root, dueAt: nowMs });
    while (waiting.length > MAX_WAITING) waiting.shift();
    return counted;
  }
  // The lock is ours: the slots that waited go first, in the order they came due, then the ones due now.
  for (const w of mine) waiting.splice(waiting.indexOf(w), 1);
  const items = [...mine.map((w) => w.item), ...fresh];
  try {
    for (const item of items) {
      if (deps.shouldStop?.()) break;
      const at = deps.now().toISOString();
      const outcome = await runOne(item, root, deps);
      const status = outcome.ok ? "ok" : SKIP_CODES.has(outcome.code ?? "") ? "skipped" : "failed";
      deps.record({ item, projectRoot: root, at, status, summary: outcome.summary });
      counted++;
    }
  } finally { deps.release(); }
  return counted;
}

/** Starts the scheduler for the open project. Returns the stop function; a stopped scheduler starts nothing new. */
export function startTaskScheduler(projectRoot: string | null, deps: SchedulerDeps, intervalMs = 30_000): () => void {
  if (!projectRoot) return () => {};
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void runDueScheduled(projectRoot, { ...deps, shouldStop: () => stopped || deps.shouldStop?.() === true }).catch(() => undefined);
  };
  const timer = setInterval(tick, intervalMs);
  tick();
  return () => { stopped = true; clearInterval(timer); };
}
