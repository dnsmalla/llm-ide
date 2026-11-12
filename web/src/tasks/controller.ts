// Auto Tasks over Host API v1 (`tasks.list/run/status/cancel`): the desktop's task registry, this browser's recent runs
// (bounded, persisted per desktop) and status polling while a run is active. No React.
import type { HostLink } from "../host-api/connection.ts";
import type { KeyValue } from "../host-api/storage.ts";
import type { HostApiResult } from "../host-api/types.generated.ts";
import { mapFeatureError, type FeatureError } from "./errors.ts";

export type TaskDef = HostApiResult<"tasks.list">["tasks"][number];
export type TaskStatus = "running" | "completed" | "failed" | "cancelled";
export interface TaskRun {
  runId: string; taskId: string; label: string; startedAt: number; status: TaskStatus;
  summary?: string; output?: string; error?: string;
}
export interface TasksState {
  tasks: readonly TaskDef[]; loading: boolean; loaded: boolean; error: FeatureError | null;
  runs: readonly TaskRun[]; starting: boolean; actionError: FeatureError | null;
}
export const initialTasksState: TasksState = { tasks: [], loading: false, loaded: false, error: null, runs: [], starting: false, actionError: null };

export const MAX_RECENT_RUNS = 20;
export const MAX_STORED_OUTPUT = 8000; // chars kept per run in browser storage (the host allows 100000)
export const POLL_MS = 3000;
export const POLL_MAX_MS = 15000;
const STORAGE_PREFIX = "llmide.web.taskRuns.v1:";
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STATUSES = new Set<string>(["running", "completed", "failed", "cancelled"]);

const clip = (s: unknown, n: number): string | undefined => (typeof s === "string" && s ? s.slice(0, n) : undefined);

/** Parse what storage holds: anything malformed is dropped, the list is bounded. */
export function parseStoredRuns(raw: string | null): TaskRun[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: TaskRun[] = [];
    for (const r of v as Partial<TaskRun>[]) {
      if (!r || typeof r.runId !== "string" || !RUN_ID.test(r.runId) || typeof r.status !== "string" || !STATUSES.has(r.status)) continue;
      out.push({
        runId: r.runId, taskId: String(r.taskId ?? "").slice(0, 120), label: String(r.label ?? r.taskId ?? "").slice(0, 120),
        startedAt: Number(r.startedAt) || 0, status: r.status as TaskStatus,
        summary: clip(r.summary, 2000), output: clip(r.output, MAX_STORED_OUTPUT), error: clip(r.error, 2000),
      });
      if (out.length >= MAX_RECENT_RUNS) break;
    }
    return out;
  } catch { return []; }
}

export interface TasksControllerOptions {
  /** Browser storage; null keeps runs in memory only. */
  storage: KeyValue | null;
  /** Identifies the paired desktop (its URL or certificate id), so runs do not mix across desktops. */
  desktopKey: string;
  /** Older keys (the URL) whose runs move to desktopKey on first load. */
  legacyKeys?: readonly string[];
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/** Forget: drop this desktop's stored runs (output can be large), under the identity key and every URL key. Best effort. */
export function forgetTaskRuns(storage: KeyValue | null, keys: readonly string[]): void {
  for (const k of keys) { try { storage?.removeItem(STORAGE_PREFIX + k); } catch { /* nothing to do */ } }
}

export function createTasksController(link: HostLink, opts: TasksControllerOptions) {
  const { storage, desktopKey } = opts;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const key = STORAGE_PREFIX + desktopKey;
  let initialRuns: TaskRun[] = [];
  try {
    let raw = storage?.getItem(key) ?? null;
    for (const old of opts.legacyKeys ?? []) {
      if (old === desktopKey) continue;
      const legacy = storage?.getItem(STORAGE_PREFIX + old) ?? null;
      if (legacy === null) continue;
      if (raw === null) { raw = legacy; storage?.setItem(key, legacy); }
      storage?.removeItem(STORAGE_PREFIX + old);
    }
    initialRuns = parseStoredRuns(raw);
  } catch { /* memory only */ }
  let state: TasksState = { ...initialTasksState, runs: initialRuns };
  const subs = new Set<() => void>();
  let loadSeq = 0;
  let timer: unknown = null;
  let active = false; // visible and mounted
  let polling = false;
  let idle = 0; // polls in a row with no change, for the back-off

  const set = (p: Partial<TasksState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  const persist = () => {
    try {
      const trimmed = state.runs.slice(0, MAX_RECENT_RUNS).map((r) => ({ ...r, output: r.output?.slice(0, MAX_STORED_OUTPUT) }));
      storage?.setItem(key, JSON.stringify(trimmed));
    } catch { /* quota or private mode: memory keeps it */ }
  };
  const patchRun = (runId: string, p: Partial<TaskRun>) => {
    set({ runs: state.runs.map((r) => (r.runId === runId ? { ...r, ...p } : r)) });
    persist();
  };
  const running = () => state.runs.filter((r) => r.status === "running");

  async function pollOnce(): Promise<void> {
    if (polling) return;
    polling = true;
    let changed = false;
    try {
      for (const r of running()) {
        try {
          const s = await link.send("tasks.status", { runId: r.runId }).done;
          if (s.status !== r.status || s.summary !== r.summary || s.output !== r.output) changed = true;
          patchRun(r.runId, { status: s.status, summary: clip(s.summary, 2000), output: clip(s.output, 100000), error: clip(s.error, 2000) });
        } catch (e) {
          const m = mapFeatureError(e, "Auto Tasks");
          // not_found: the desktop forgot this run (restart); do not poll it forever.
          if ((e as { code?: string })?.code === "not_found") { patchRun(r.runId, { status: "failed", error: "The desktop no longer knows this run." }); changed = true; }
          else set({ actionError: m });
        }
      }
    } finally { polling = false; }
    idle = changed ? 0 : idle + 1;
  }

  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  function schedule() {
    stopTimer();
    if (!active || running().length === 0) return;
    const delay = Math.min(POLL_MAX_MS, POLL_MS * (1 + Math.floor(idle / 4)));
    timer = setTimer(() => { timer = null; void pollOnce().then(schedule); }, delay);
  }

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    isPolling: () => timer !== null,

    async load(): Promise<void> {
      const mine = ++loadSeq;
      set({ loading: true, error: null });
      try {
        const r = await link.send("tasks.list", {}).done;
        if (mine !== loadSeq) return;
        set({ tasks: Array.isArray(r?.tasks) ? r.tasks.slice(0, 500) : [], loading: false, loaded: true, error: null });
      } catch (e) {
        if (mine !== loadSeq) return;
        set({ loading: false, loaded: true, error: mapFeatureError(e, "Auto Tasks") });
      }
    },

    /** args: only non-empty strings (the host takes strings; a string[] arg is one item per line). */
    async run(task: TaskDef, projectId: string | null, args: Record<string, string>): Promise<boolean> {
      if (state.starting) return false;
      const payload: { taskId: string; projectId?: string; args?: Record<string, string> } = { taskId: task.id };
      if (projectId && task.scope === "project") payload.projectId = projectId;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(args)) if (v.trim()) clean[k] = v;
      if (Object.keys(clean).length) payload.args = clean;
      set({ starting: true, actionError: null });
      try {
        const { runId } = await link.send("tasks.run", payload).done;
        const run: TaskRun = { runId, taskId: task.id, label: task.label, startedAt: now(), status: "running" };
        set({ starting: false, runs: [run, ...state.runs.filter((r) => r.runId !== runId)].slice(0, MAX_RECENT_RUNS) });
        persist();
        idle = 0;
        schedule();
        return true;
      } catch (e) {
        set({ starting: false, actionError: mapFeatureError(e, "Auto Tasks") });
        return false;
      }
    },

    async cancel(runId: string): Promise<void> {
      set({ actionError: null });
      try {
        const r = await link.send("tasks.cancel", { runId }).done;
        if (r.cancelled) patchRun(runId, { status: "cancelled" });
        else await pollOnce();
      } catch (e) { set({ actionError: mapFeatureError(e, "Auto Tasks") }); }
      schedule();
    },

    clearFinished(): void {
      set({ runs: state.runs.filter((r) => r.status === "running") });
      persist();
    },
    dismissActionError(): void { set({ actionError: null }); },

    /** The section is on screen and the page is visible: poll while a run is running. */
    setActive(on: boolean): void {
      active = on;
      if (!on) { stopTimer(); return; }
      if (running().length) { idle = 0; void pollOnce().then(schedule); }
    },
    dispose(): void { active = false; stopTimer(); },
    pollOnce,
  };
}
export type TasksController = ReturnType<typeof createTasksController>;
