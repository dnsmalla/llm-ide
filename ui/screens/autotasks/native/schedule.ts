// Shell-level scheduler for CUSTOM Auto Tasks. The built-in tasks still schedule from their page; custom tasks used to
// have no scheduler at all. This module is mounted by the shell so a cron fires while another section is open.
import { core } from "../../shell/runtime";
import { invokeHost } from "../../shell/host";
import { dueCustomTasks as dueTasks, loadCustomTasks } from "./custom.ts";
import { runCustomTask } from "./run-custom.ts";
import { loadState } from "./model.ts";

const FIRED_KEY = "llmide.customAutoTaskFired.v1";
export const CUSTOM_RUNS_KEY = "llmide.customTaskRuns.v1";
export const CUSTOM_RUNS_EVENT = "llmide-custom-task-runs";

export interface CustomTaskRun { id: string; taskId: string; task: string; at: string; ok: boolean; summary: string; trigger: "cron" | "manual"; }

export function readCustomRuns(storage: Storage | undefined = globalThis.localStorage): CustomTaskRun[] {
  try { const raw = storage?.getItem(CUSTOM_RUNS_KEY); const v = raw ? JSON.parse(raw) as unknown : []; return Array.isArray(v) ? v.slice(0, 50) as CustomTaskRun[] : []; } catch { return []; }
}

export function appendCustomRun(run: CustomTaskRun, storage: Storage | undefined = globalThis.localStorage): CustomTaskRun[] {
  const next = [run, ...readCustomRuns(storage)].slice(0, 50);
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

/** Start the background tick. Returns a stop function; safe to mount once in the shell. */
export function startCustomTaskScheduler(projectRoot: string | null, intervalMs = 30_000): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || !projectRoot) return;
    const state = loadState();
    if (!state.masterEnabled) return;
    const tasks = loadCustomTasks(projectRoot);
    const now = new Date();
    const fired = readFired(localStorage);
    const due = customTasksDue(tasks, true, now, fired);
    if (due.length === 0) return;
    running = true;
    try {
      for (const task of due) {
        const key = `${task.id}:${minuteKey(now)}`;
        if (fired[key]) continue;
        fired[key] = minuteKey(now);
        try { localStorage.setItem(FIRED_KEY, JSON.stringify(Object.fromEntries(Object.entries(fired).slice(-200)))); } catch { /* session */ }
        const started = new Date();
        try {
          const result = await runCustomTask(task, {
            request: (path, init) => core.request(path, init as never),
            workRoot: () => invokeHost<string>("loop_work_root"),
            changedPaths: async () => { try { return await invokeHost<string[]>("loop_changed_paths"); } catch { return null; } },
            revert: async (paths, created) => { await invokeHost("loop_revert_paths", { paths, created }); },
          });
          appendCustomRun({
            id: crypto.randomUUID(), taskId: task.id, task: task.name, at: started.toISOString(), ok: result.ok,
            summary: result.reply.trim().split("\n")[0]?.slice(0, 300) || result.error || (result.ok ? "completed" : "failed"),
            trigger: "cron",
          });
        } catch (e) {
          appendCustomRun({ id: crypto.randomUUID(), taskId: task.id, task: task.name, at: started.toISOString(), ok: false, summary: e instanceof Error ? e.message : "failed", trigger: "cron" });
        }
      }
    } finally { running = false; }
  };
  const timer = window.setInterval(() => { void tick(); }, intervalMs);
  const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
  document.addEventListener("visibilitychange", onVisible);
  void tick();
  return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
}
