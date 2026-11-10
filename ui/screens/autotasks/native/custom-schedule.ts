// Run history for CUSTOM Auto Tasks (`llmide.customTaskRuns.v1`). Custom tasks are scheduled by the one desktop scheduler
// (ui/screens/tasks/schedule.ts); this module only keeps their records, project-scoped and validated.

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
