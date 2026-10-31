import { useCallback, useEffect, useState } from "react";
import { core, coreStatusStore } from "./runtime";
import { host, type ProjectInfo } from "./host";
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
  recent: ProjectInfo[];
  /** Native dialog; null when cancelled. */
  openFolder(): Promise<void>;
  openRecent(index: number): Promise<void>;
  error: string | null;
  refresh(): Promise<void>;
}

/** Project state via host commands only (never webview-supplied paths). */
export function useActiveProject(): ActiveProject {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [recent, setRecent] = useState<ProjectInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([host.projectActive(), host.projectRecent()]);
      setProject(p);
      setRecent(r);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openFolder = useCallback(async () => {
    try {
      const p = await host.projectOpen();
      if (p) setProject(p);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const openRecent = useCallback(
    async (index: number) => {
      try {
        setProject(await host.projectOpenRecent(index));
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  return { project, recent, openFolder, openRecent, error, refresh };
}
