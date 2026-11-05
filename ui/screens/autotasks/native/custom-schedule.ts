// Shell-level scheduler for CUSTOM Auto Tasks. The built-in tasks still schedule from their page; custom tasks used to
// have no scheduler at all. This module is mounted by the shell so a cron fires while another section is open.
import { dueCustomTasks as dueTasks, loadCustomTasks, type CustomAutoTask } from "./custom.ts";
import { releaseAutoTask, tryAcquireAutoTask } from "./lock.ts";
import { loadState } from "./model.ts";

const FIRED_KEY = "llmide.customAutoTaskFired.v1";
const firedMemory: Record<string, string> = {};
export const CUSTOM_RUNS_KEY = "llmide.customTaskRuns.v1";
export const CUSTOM_RUNS_EVENT = "llmide-custom-task-runs";

export interface CustomTaskRun { id: string; taskId: string; task: string; projectRoot: string; at: string; ok: boolean; summary: string; trigger: "cron" | "manual"; }

const validRun = (r: unknown): r is CustomTaskRun => Boolean(r && typeof r === "object"
  && typeof (r as CustomTaskRun).id === "string" && typeof (r as CustomTaskRun).taskId === "string"
  && typeof (r as CustomTaskRun).task === "string" && typeof (r as CustomTaskRun).projectRoot === "string"
  && typeof (r as CustomTaskRun).at === "string" && typeof (r as CustomTaskRun).ok === "boolean"
  && typeof (r as CustomTaskRun).summary === "string" && ((r as CustomTaskRun).trigger === "cron" || (r as CustomTaskRun).trigger === "manual"));

export function readCustomRuns(storage: Storage | undefined = globalThis.localStorage, projectRoot?: string): CustomTaskRun[] {
  try {
    const raw = storage?.getItem(CUSTOM_RUNS_KEY); const v = raw ? JSON.parse(raw) as unknown : [];
    const list = Array.isArray(v) ? v.filter(validRun) : [];
    for (const r of list) r.projectRoot = r.projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (!projectRoot) return list.slice(0, 50);
    const root = projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    return list.filter((r) => r.projectRoot === root).slice(0, 50);
  } catch { return []; }
}

export function appendCustomRun(run: CustomTaskRun, storage: Storage | undefined = globalThis.localStorage): CustomTaskRun[] {
  const all = [run, ...readCustomRuns(storage)];
  const root = run.projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const same = all.filter((r) => r.projectRoot === root).slice(0, 50);
  const other = all.filter((r) => r.projectRoot !== root).slice(0, 150);
  const next = [...same, ...other];
  try { storage?.setItem(CUSTOM_RUNS_KEY, JSON.stringify(next)); } catch { /* session only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CUSTOM_RUNS_EVENT, { detail: next }));
  return next;
}

function minuteKey(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
}

function readFired(storage: Storage | undefined): Record<string, string> {
  try { const raw = storage?.getItem(FIRED_KEY); const v = raw ? JSON.parse(raw) as unknown : {}; return v && typeof v === "object" ? v as Record<string, string> : {}; } catch { return {}; }
}

/** The tasks due at this tick: enabled, cron valid and matching, master switch on, not fired this minute. */
export const customTasksDue = dueTasks;

export interface DueTaskDeps {
  storage?: Storage;
  now?: Date;
  run(task: CustomAutoTask): Promise<{ ok: boolean; reply: string; error?: string; writes: string[] }>;
  shouldStop?(): boolean;
}

/** One scheduler pass, extracted from the timer so it can be tested with a fake runner/storage. */
export async function runDueCustomTasks(projectRoot: string | null, deps: DueTaskDeps): Promise<number> {
  if (!projectRoot) return 0;
  const storage = deps.storage ?? globalThis.localStorage;
  const state = loadState(storage);
  if (!state.masterEnabled) return 0;
  const tasks = loadCustomTasks(projectRoot, storage);
  const now = deps.now ?? new Date();
  const fired = { ...readFired(storage), ...firedMemory };
  const due = customTasksDue(tasks, true, now, fired);
  if (due.length === 0) return 0;
  if (!tryAcquireAutoTask()) return 0;
  let ran = 0;
  try {
    for (const task of due) {
      if (deps.shouldStop?.()) break;
      const key = `${task.id}:${minuteKey(now)}`;
      if (fired[key]) continue;
      fired[key] = minuteKey(now);
      firedMemory[key] = minuteKey(now);
      const memoryKeys = Object.keys(firedMemory);
      if (memoryKeys.length > 200) for (const k of memoryKeys.slice(0, memoryKeys.length - 200)) delete firedMemory[k];
      try { storage.setItem(FIRED_KEY, JSON.stringify(Object.fromEntries(Object.entries(fired).slice(-200)))); } catch { /* memory still dedupes this session */ }
      const started = new Date();
      try {
        const result = await deps.run(task);
        appendCustomRun({
          id: crypto.randomUUID(), taskId: task.id, task: task.name, projectRoot, at: started.toISOString(), ok: result.ok,
          summary: `${result.reply.trim().split("\n")[0]?.slice(0, 260) || result.error || (result.ok ? "completed" : "failed")}${result.writes.length ? ` (left: ${result.writes.join(", ")})` : ""}`.slice(0, 300),
          trigger: "cron",
        }, storage);
        ran++;
      } catch (e) {
        appendCustomRun({ id: crypto.randomUUID(), taskId: task.id, task: task.name, projectRoot, at: started.toISOString(), ok: false, summary: e instanceof Error ? e.message : "failed", trigger: "cron" }, storage);
      }
      if (deps.shouldStop?.()) break;
    }
  } finally { releaseAutoTask(); }
  return ran;
}

