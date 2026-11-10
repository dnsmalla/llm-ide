// The one run list for registry tasks, manual and scheduled. Records keep the label they ran under (`task`) for display
// and the registry id (`taskId`) so a later rename does not orphan history. Written from the scheduler as well as the page,
// so the page re-reads it on TASK_RUNS_EVENT rather than keeping its own copy.
export const TASK_RUNS_KEY = "llmide.autoTaskRuns.v1";
export const TASK_RUNS_EVENT = "llmide-task-runs";
const MAX_RUNS = 50;

export interface TaskRunRecord {
  id: string;
  /** Registry id; absent on records written before Task 15. */
  taskId?: string;
  /** The label at the time of the run. */
  task: string;
  at: string;
  ok: boolean;
  /** A slot that was refused (cap, approval, live write run) rather than run. */
  skipped?: boolean;
  summary: string;
  durationSeconds: number;
}

const valid = (r: unknown): r is TaskRunRecord => Boolean(r && typeof r === "object"
  && typeof (r as TaskRunRecord).id === "string" && typeof (r as TaskRunRecord).task === "string"
  && typeof (r as TaskRunRecord).at === "string" && typeof (r as TaskRunRecord).summary === "string");

export function readTaskRuns(storage: Storage | undefined = globalThis.localStorage): TaskRunRecord[] {
  try {
    const raw = storage?.getItem(TASK_RUNS_KEY);
    const v = raw ? JSON.parse(raw) as unknown : [];
    return Array.isArray(v) ? v.filter(valid).slice(0, MAX_RUNS) : [];
  } catch { return []; }
}

export function appendTaskRun(run: TaskRunRecord, storage: Storage | undefined = globalThis.localStorage): TaskRunRecord[] {
  const next = [run, ...readTaskRuns(storage)].slice(0, MAX_RUNS);
  try { storage?.setItem(TASK_RUNS_KEY, JSON.stringify(next)); } catch { /* session only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(TASK_RUNS_EVENT));
  return next;
}
