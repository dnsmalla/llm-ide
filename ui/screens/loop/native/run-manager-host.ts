// Wires the factory run manager to the real host, core, file API and project store. The Factory board calls
// installRunManagerHost() on mount; it is idempotent, so runs survive the board unmounting.
import { createHostFs } from "../../explorer/fs";
import { invokeHost } from "../../shell/host";
import { projectStore } from "../../shell/project-store";
import { core } from "../../shell/runtime";
import { readRepoConfig } from "../../settings/repo-config";
import { approveLoop } from "./approvals.ts";
import { repoForIssue } from "./factory.ts";
import { configureRunManager, projectGuardedFs } from "./run-manager.ts";

let installed = false;

export function installRunManagerHost(): void {
  if (installed) return;
  installed = true;
  const hostFs = createHostFs();
  const activeProject = () => projectStore.getSnapshot().project?.root ?? null;
  configureRunManager({
    host: invokeHost,
    core,
    fsFor: (root) => projectGuardedFs(hostFs, root, activeProject),
    approve: async (loopId) => (await approveLoop(loopId))?.token ?? null,
    // An issue runs in the clone Settings → Repositories maps its owner/name slug to (null = not mapped).
    repoForSlug: (provider, slug, projectRoot) => repoForIssue({ provider, repo: slug }, readRepoConfig().saved, projectRoot),
    activeProject,
    subscribeProject: (listener) => projectStore.subscribe(listener),
  });
}
