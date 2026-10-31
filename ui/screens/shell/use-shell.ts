import { useEffect } from "react";
import { core, coreStatusStore } from "./runtime";
import type { ProjectInfo, RecentEntry, RecentList } from "./host";
import { projectStore, type AfterCreate } from "./project-store";
import { useStoreSelector } from "./hooks";
import { deriveStatusView, statusViewEqual, type StatusView } from "./status-view";
import type { SessionSnapshot } from "./core";

/** Login state of the core client (token-free). Re-renders only when it changes. */
export function useCoreSession(): SessionSnapshot {
  return useStoreSelector({ getSnapshot: core.getSnapshot, subscribe: core.subscribe }, (s) => s);
}

/** Core status as shown by the shell. Re-renders only when the derived view changes. */
export function useCoreStatusView(): StatusView {
  return useStoreSelector(coreStatusStore, deriveStatusView, statusViewEqual);
}

export interface ActiveProject {
  project: ProjectInfo | null;
  recent: readonly ProjectInfo[];
  /** Recent list with a status per entry (Welcome). */
  recentAll: RecentList;
  loaded: boolean;
  error: string | null;
  /** One-off message after an action (shown by the shell until dismissed). */
  notice: string | null;
  /** Native folder dialog (host-owned); a cancel changes nothing. */
  openFolder(): Promise<void>;
  openRecent(index: number): Promise<void>;
  /** Host folder dialog for the parent, then create + scaffold; `after` registers it with the core. */
  createProject(name: string, after?: AfterCreate): Promise<ProjectInfo | null>;
  /** Back to no project. Never deletes anything. */
  closeProject(): Promise<void>;
  forgetRecent(entry: RecentEntry): Promise<void>;
  dismissNotice(): void;
  refresh(): Promise<void>;
}

const PROJECT_ACTIONS = {
  openFolder: () => projectStore.openFolder(),
  openRecent: (i: number) => projectStore.openRecent(i),
  createProject: (name: string, after?: AfterCreate) => projectStore.createProject(name, after),
  closeProject: () => projectStore.closeProject(),
  forgetRecent: (e: RecentEntry) => projectStore.forgetRecent(e),
  dismissNotice: () => projectStore.dismissNotice(),
  refresh: () => projectStore.refresh(),
};

/** Project state via host commands only (never webview-supplied paths); shared across the shell. */
export function useActiveProject(): ActiveProject {
  const s = useStoreSelector(projectStore, (x) => x);
  useEffect(() => {
    if (!projectStore.getSnapshot().loaded) void projectStore.refresh();
  }, []);
  return { ...s, ...PROJECT_ACTIONS };
}
