// Loop over Host API v1 (`loop.list/start/cancel/history/issues`): runs for the selected project, the issues a run can
// take, and the desktop's own loop history. Polls while a run is active. No React.
import type { HostLink } from "../host-api/connection.ts";
import type { HostApiResult } from "../host-api/types.generated.ts";
import { mapFeatureError, type FeatureError } from "../tasks/errors.ts";

export type LoopRun = HostApiResult<"loop.list">["runs"][number];
export type LoopIssue = HostApiResult<"loop.issues">["issues"][number];
export type LoopHistoryRun = HostApiResult<"loop.history">["runs"][number];
export type LoopRunState = LoopRun["state"];

export const MAX_LOOP_ISSUES = 20; // loop.start issueIds maxItems
export const POLL_MS = 4000;
export const POLL_MAX_MS = 20000;
/** States a run can still leave on its own; the others are final. */
export const ACTIVE_STATES: ReadonlySet<string> = new Set(["awaiting_approval", "queued", "running"]);
export const isActive = (s: string) => ACTIVE_STATES.has(s);
export const canCancel = isActive;

export interface LoopState {
  projectId: string | null;
  runs: readonly LoopRun[]; loading: boolean; loaded: boolean; error: FeatureError | null;
  issues: readonly LoopIssue[]; issuesLoading: boolean; issuesLoaded: boolean; issuesError: FeatureError | null;
  history: readonly LoopHistoryRun[]; historyError: FeatureError | null;
  starting: boolean; actionError: FeatureError | null;
  /** Set after a successful start: the run waits for approval on the desktop. */
  lastStarted: { id: string; state: LoopRunState } | null;
}
export const initialLoopState: LoopState = {
  projectId: null, runs: [], loading: false, loaded: false, error: null, issues: [], issuesLoading: false, issuesLoaded: false, issuesError: null,
  history: [], historyError: null, starting: false, actionError: null, lastStarted: null,
};

export interface LoopControllerOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export function createLoopController(link: HostLink, opts: LoopControllerOptions = {}) {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let state: LoopState = initialLoopState;
  const subs = new Set<() => void>();
  let seq = 0;
  let timer: unknown = null;
  let active = false;
  let idle = 0;
  let inflight = false;

  const set = (p: Partial<LoopState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };
  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const anyActive = () => state.runs.some((r) => isActive(r.state));
  const sig = (runs: readonly LoopRun[]) => runs.map((r) => `${r.id}:${r.state}:${r.step ?? ""}:${r.readyToShip ?? ""}`).join("|");

  async function refreshRuns(silent: boolean): Promise<void> {
    const projectId = state.projectId;
    if (!projectId || inflight) return;
    inflight = true;
    const mine = seq;
    if (!silent) set({ loading: true, error: null });
    try {
      const r = await link.send("loop.list", { projectId }).done;
      if (mine !== seq) return;
      const runs = Array.isArray(r?.runs) ? r.runs.slice(0, 50) : [];
      idle = sig(runs) === sig(state.runs) ? idle + 1 : 0;
      set({ runs, loading: false, loaded: true, error: null });
    } catch (e) {
      if (mine !== seq) return;
      set(silent ? { actionError: mapFeatureError(e, "Loop") } : { loading: false, loaded: true, error: mapFeatureError(e, "Loop") });
    } finally { inflight = false; }
  }

  function schedule() {
    stopTimer();
    if (!active || !anyActive()) return;
    const delay = Math.min(POLL_MAX_MS, POLL_MS * (1 + Math.floor(idle / 4)));
    timer = setTimer(() => { timer = null; void refreshRuns(true).then(schedule); }, delay);
  }

  async function loadHistory(): Promise<void> {
    const projectId = state.projectId;
    if (!projectId) return;
    const mine = seq;
    try {
      const r = await link.send("loop.history", { projectId }).done;
      if (mine !== seq) return;
      set({ history: Array.isArray(r?.runs) ? r.runs.slice(0, 30) : [], historyError: null });
    } catch (e) { if (mine === seq) set({ history: [], historyError: mapFeatureError(e, "Loop history") }); }
  }

  return {
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    isPolling: () => timer !== null,

    /** Select the project (resets everything project-scoped) and load its runs and the desktop history. */
    async setProject(projectId: string | null): Promise<void> {
      if (projectId === state.projectId && state.loaded) return;
      seq++; inflight = false; idle = 0; stopTimer();
      state = { ...initialLoopState, projectId };
      set({});
      if (!projectId) return;
      await Promise.all([refreshRuns(false), loadHistory()]);
      schedule();
    },
    async refresh(): Promise<void> { idle = 0; await Promise.all([refreshRuns(false), loadHistory()]); schedule(); },

    async loadIssues(): Promise<void> {
      const projectId = state.projectId;
      if (!projectId) return;
      const mine = seq;
      set({ issuesLoading: true, issuesError: null });
      try {
        const r = await link.send("loop.issues", { projectId, limit: 100 }).done;
        if (mine !== seq) return;
        set({ issues: Array.isArray(r?.issues) ? r.issues.slice(0, 100) : [], issuesLoading: false, issuesLoaded: true });
      } catch (e) { if (mine === seq) set({ issuesLoading: false, issuesLoaded: true, issuesError: mapFeatureError(e, "Loop") }); }
    },

    async start(issueIds: readonly string[]): Promise<boolean> {
      const projectId = state.projectId;
      if (!projectId || state.starting || issueIds.length === 0 || issueIds.length > MAX_LOOP_ISSUES) return false;
      set({ starting: true, actionError: null, lastStarted: null });
      try {
        const r = await link.send("loop.start", { projectId, issueIds: [...issueIds] }).done;
        set({ starting: false, lastStarted: { id: r.id, state: r.state } });
        idle = 0;
        await refreshRuns(true);
        schedule();
        return true;
      } catch (e) { set({ starting: false, actionError: mapFeatureError(e, "Loop") }); return false; }
    },

    async cancel(id: string): Promise<void> {
      set({ actionError: null });
      try { await link.send("loop.cancel", { id }).done; }
      catch (e) { set({ actionError: mapFeatureError(e, "Loop") }); }
      idle = 0;
      await refreshRuns(true);
      schedule();
    },
    dismissActionError(): void { set({ actionError: null }); },
    dismissStarted(): void { set({ lastStarted: null }); },

    setActive(on: boolean): void {
      active = on;
      if (!on) { stopTimer(); return; }
      if (state.loaded) { idle = 0; void refreshRuns(true).then(schedule); }
      else schedule();
    },
    dispose(): void { active = false; seq++; stopTimer(); },
  };
}
export type LoopController = ReturnType<typeof createLoopController>;
