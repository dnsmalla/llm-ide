// Active project + recent list as one shared store (shell, Welcome and status bar read the same state).
// Paths come from the host only; the webview never supplies one.
import { host as defaultHost, type ProjectInfo, type RecentEntry, type RecentList } from "./host";
import { unsavedWork } from "./unsaved-work.ts";

export interface ProjectState {
  project: ProjectInfo | null;
  recent: readonly ProjectInfo[];
  /** Recent list with a status per entry (Welcome). */
  recentAll: RecentList;
  error: string | null;
  /** One-off message to show after an action (e.g. "created, but skills were not installed"). */
  notice: string | null;
  /** True after the first successful or failed load, so screens mount once with the right project. */
  loaded: boolean;
  /** A project change is waiting for an answer: these are the unsaved things it would discard. */
  leave: { labels: readonly string[] } | null;
}

export interface ProjectHost {
  projectActive(): Promise<ProjectInfo | null>;
  projectRecent(): Promise<ProjectInfo[]>;
  projectOpen(): Promise<ProjectInfo | null>;
  projectOpenRecent(index: number): Promise<ProjectInfo>;
  projectRecentAll?(): Promise<RecentList>;
  projectCreate?(name: string): Promise<ProjectInfo | null>;
  projectClose?(): Promise<void>;
  projectForgetRecent?(storedIndex: number, root: string): Promise<boolean>;
}

/** Runs after the host created a project, before the shell switches to it: core registration, skills. Returns warnings. */
export type AfterCreate = (project: ProjectInfo) => Promise<string[]>;

export interface ProjectStore {
  getSnapshot(): ProjectState;
  subscribe(l: () => void): () => void;
  refresh(): Promise<void>;
  /** These three resolve true when the action ran, false when the user chose to stay (see `leave`). */
  openFolder(): Promise<boolean>;
  openRecent(index: number): Promise<boolean>;
  /** Native "choose where" dialog, then create + scaffold. Resolves the new project, or null on cancel/failure (see `error`). */
  createProject(name: string, after?: AfterCreate): Promise<ProjectInfo | null>;
  /** Back to "no project". The recent list is kept; nothing is deleted. */
  closeProject(): Promise<boolean>;
  /** Drop one entry from the recent list only. */
  forgetRecent(entry: RecentEntry): Promise<void>;
  dismissNotice(): void;
  /** Answers the pending `leave` question: go ahead and lose the unsaved work. */
  confirmLeave(): void;
  /** Answers the pending `leave` question: stay in this project; nothing changes. */
  cancelLeave(): void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : typeof e === "string" ? e : String(e));
const EMPTY_RECENT: RecentList = { entries: [], reset: false };

export function createProjectStore(h: ProjectHost = defaultHost, unsaved: () => readonly string[] = unsavedWork.list): ProjectStore {
  let state: ProjectState = { project: null, recent: [], recentAll: EMPTY_RECENT, error: null, notice: null, loaded: false, leave: null };
  const listeners = new Set<() => void>();
  const sameAll = (a: RecentList, b: RecentList) =>
    a.reset === b.reset && a.entries.length === b.entries.length && a.entries.every((e, i) => JSON.stringify(e) === JSON.stringify(b.entries[i]));
  const set = (patch: Partial<ProjectState>) => {
    const next = { ...state, ...patch };
    if (patch.recentAll && sameAll(patch.recentAll, state.recentAll)) next.recentAll = state.recentAll;
    if (
      next.project?.root === state.project?.root && next.project?.name === state.project?.name && next.recent === state.recent &&
      next.recentAll === state.recentAll && next.error === state.error && next.notice === state.notice && next.loaded === state.loaded &&
      next.leave === state.leave
    ) return;
    // Keep the old project object when unchanged: selectors by identity stay stable.
    if (next.project && state.project && next.project.root === state.project.root && next.project.name === state.project.name) next.project = state.project;
    state = next;
    for (const l of [...listeners]) l();
  };
  const sameList = (a: readonly ProjectInfo[], b: readonly ProjectInfo[]) => a.length === b.length && a.every((p, i) => p.root === b[i]?.root && p.name === b[i]?.name);

  const refresh = async () => {
    try {
      const [project, recent, recentAll] = await Promise.all([h.projectActive(), h.projectRecent(), h.projectRecentAll ? h.projectRecentAll() : Promise.resolve(EMPTY_RECENT)]);
      set({ project, recent: sameList(recent, state.recent) ? state.recent : recent, recentAll, error: null, loaded: true });
    } catch (e) {
      set({ error: msg(e), loaded: true });
    }
  };

  // Every action that changes the active project goes through here, BEFORE the host is called: the host switches
  // its active root first, and the shell then remounts every section, which drops whatever they had not saved.
  let pending: { run: () => void; cancel: () => void } | null = null;
  const leaving = <T>(cancelled: T, action: () => Promise<T>): Promise<T> => {
    const labels = state.project ? unsaved() : [];
    if (labels.length === 0) return action();
    pending?.cancel(); // one question at a time: a newer request replaces the one still on screen
    return new Promise<T>((resolve) => {
      pending = { run: () => { void action().then(resolve); }, cancel: () => resolve(cancelled) };
      set({ leave: { labels } });
    });
  };
  const answerLeave = (go: boolean) => {
    const p = pending;
    pending = null;
    set({ leave: null });
    if (go) p?.run();
    else p?.cancel();
  };

  return {
    getSnapshot: () => state,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    refresh,
    confirmLeave: () => answerLeave(true),
    cancelLeave: () => answerLeave(false),
    openFolder: () => leaving(false, async () => {
      try {
        const p = await h.projectOpen();
        if (p) set({ project: p, error: null });
      } catch (e) {
        set({ error: msg(e) });
        return true;
      }
      await refresh();
      return true;
    }),
    openRecent(index) {
      // Re-opening the project that is already open remounts nothing, so there is nothing to ask about.
      const target = state.recentAll.entries.find((e) => e.openIndex === index);
      const open = async () => {
        // The host opens by list position. The question can stay open while the list changes, so the position is
        // looked up again by root: "Discard and leave" must open the project that was clicked, or nothing.
        let at = index;
        if (target) {
          const now = state.recentAll.entries.find((e) => e.root === target.root);
          if (!now || now.openIndex === null) {
            set({ error: `"${target.name}" is no longer in the recent list.` });
            return true;
          }
          at = now.openIndex;
        }
        try {
          set({ project: await h.projectOpenRecent(at), error: null });
        } catch (e) {
          set({ error: msg(e) });
          return true;
        }
        await refresh();
        return true;
      };
      return target && target.root === state.project?.root ? open() : leaving(false, open);
    },
    createProject: (name, after) => leaving(null, async () => {
      if (!h.projectCreate) {
        set({ error: "Creating a project needs the desktop app." });
        return null;
      }
      let created: ProjectInfo | null;
      try {
        created = await h.projectCreate(name);
      } catch (e) {
        set({ error: msg(e) });
        return null;
      }
      if (!created) return null; // the user cancelled the folder dialog
      let warnings: string[] = [];
      try {
        warnings = after ? await after(created) : [];
      } catch (e) {
        warnings = [msg(e)];
      }
      // The host already made it active; publishing it now lets the shell land on the project home.
      set({ project: created, error: null, notice: warnings.length ? `Project "${created.name}" was created. ${warnings.join(" ")}` : null });
      await refresh();
      return created;
    }),
    closeProject: () => leaving(false, async () => {
      try {
        await h.projectClose?.();
        set({ project: null, error: null });
      } catch (e) {
        set({ error: msg(e) });
        return true;
      }
      await refresh();
      return true;
    }),
    async forgetRecent(entry) {
      try {
        await h.projectForgetRecent?.(entry.storedIndex, entry.root);
        set({ error: null });
      } catch (e) {
        set({ error: msg(e) });
      }
      await refresh();
    },
    dismissNotice() {
      set({ notice: null });
    },
  };
}

export const projectStore = createProjectStore();
