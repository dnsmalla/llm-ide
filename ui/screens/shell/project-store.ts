// Active project + recent list as one shared store (shell and status bar read the same state).
// Paths come from the host only; the webview never supplies one.
import { host as defaultHost, type ProjectInfo } from "./host";

export interface ProjectState {
  project: ProjectInfo | null;
  recent: readonly ProjectInfo[];
  error: string | null;
  /** True after the first successful or failed load, so screens mount once with the right project. */
  loaded: boolean;
}

export interface ProjectHost {
  projectActive(): Promise<ProjectInfo | null>;
  projectRecent(): Promise<ProjectInfo[]>;
  projectOpen(): Promise<ProjectInfo | null>;
  projectOpenRecent(index: number): Promise<ProjectInfo>;
}

export interface ProjectStore {
  getSnapshot(): ProjectState;
  subscribe(l: () => void): () => void;
  refresh(): Promise<void>;
  openFolder(): Promise<void>;
  openRecent(index: number): Promise<void>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createProjectStore(h: ProjectHost = defaultHost): ProjectStore {
  let state: ProjectState = { project: null, recent: [], error: null, loaded: false };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ProjectState>) => {
    const next = { ...state, ...patch };
    if (next.project?.root === state.project?.root && next.project?.name === state.project?.name && next.recent === state.recent && next.error === state.error && next.loaded === state.loaded) return;
    // Keep the old project object when unchanged: selectors by identity stay stable.
    if (next.project && state.project && next.project.root === state.project.root && next.project.name === state.project.name) next.project = state.project;
    state = next;
    for (const l of [...listeners]) l();
  };
  const sameList = (a: readonly ProjectInfo[], b: readonly ProjectInfo[]) => a.length === b.length && a.every((p, i) => p.root === b[i]?.root && p.name === b[i]?.name);

  const refresh = async () => {
    try {
      const [project, recent] = await Promise.all([h.projectActive(), h.projectRecent()]);
      set({ project, recent: sameList(recent, state.recent) ? state.recent : recent, error: null, loaded: true });
    } catch (e) {
      set({ error: msg(e), loaded: true });
    }
  };

  return {
    getSnapshot: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh,
    async openFolder() {
      try {
        const p = await h.projectOpen();
        if (p) set({ project: p, error: null });
      } catch (e) {
        set({ error: msg(e) });
        return;
      }
      await refresh();
    },
    async openRecent(index) {
      try {
        set({ project: await h.projectOpenRecent(index), error: null });
      } catch (e) {
        set({ error: msg(e) });
        return;
      }
      await refresh();
    },
  };
}

export const projectStore = createProjectStore();
