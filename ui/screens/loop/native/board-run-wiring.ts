// Installs the shell-level handler of a loop board's ▶ Run request. The Shell loads this module once; it answers every
// "run-loop" bus event (also one published before it loaded) through the run manager, so the Loop page need not be open.
import { createHostFs } from "../../explorer/fs";
import { shellBus } from "../../shell/bus";
import { projectStore } from "../../shell/project-store";
import { handleBoardRunRequest, type BoardRunDeps } from "./board-run-request.ts";
import { installRunManagerHost } from "./run-manager-host.ts";
import { liveRuns, loopIdOfRun, loopRunActive, projectGuardedFs, startRun, subscribeLoopRunEvents } from "./run-manager.ts";
import { loadLoops } from "./store.ts";

const activeProject = (): string | null => projectStore.getSnapshot().project?.root ?? null;

function realDeps(): BoardRunDeps {
  return {
    projectRoot: activeProject,
    loadLoops: (root) => loadLoops(projectGuardedFs(createHostFs(), root, activeProject)),
    loopHasRun: (root, loopId) => liveRuns().some((r) => r.projectRoot === root && loopIdOfRun(r) === loopId),
    loopRunActive,
    start: (root, item) => { installRunManagerHost(); return startRun(root, item, "full"); },
    subscribeEvents: subscribeLoopRunEvents,
    tell: ({ loopName, loopId, message, started }) => window.dispatchEvent(new CustomEvent("llmide-loop-board-notice", { detail: { loopName, loopId, message, ...(started ? { started: true } : {}) } })),
  };
}

/** Subscribes to the bus and takes a request that was published before this ran. Returns the unsubscribe. */
export function installBoardRunHandler(deps: BoardRunDeps = realDeps()): () => void {
  const take = (ev: { loopId: string; inputPath?: string; task?: string } | null) => {
    if (!ev) return;
    void handleBoardRunRequest({ loopId: ev.loopId, ...(ev.inputPath !== undefined ? { inputPath: ev.inputPath } : {}), ...(ev.task !== undefined ? { task: ev.task } : {}) }, deps);
  };
  take(shellBus.takePending("run-loop"));
  return shellBus.subscribe("run-loop", (ev) => { shellBus.takePending("run-loop"); take(ev); });
}
