import { useEffect } from "react";
import { core, coreStatusStore } from "./runtime";
import type { ProjectInfo } from "./host";
import { projectStore } from "./project-store";
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
  loaded: boolean;
  error: string | null;
  /** Native folder dialog (host-owned); a cancel changes nothing. */
  openFolder(): Promise<void>;
  openRecent(index: number): Promise<void>;
  refresh(): Promise<void>;
}

const PROJECT_ACTIONS = {
  openFolder: () => projectStore.openFolder(),
  openRecent: (i: number) => projectStore.openRecent(i),
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
