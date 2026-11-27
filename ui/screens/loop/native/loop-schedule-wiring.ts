// The real deps of the loop schedule: the host file API, the project store, the run manager. The Shell starts it once
// the run manager host is installed, so scheduled loop runs fire without the Loop page open.
import { createHostFs } from "../../explorer/fs";
import { projectStore } from "../../shell/project-store";
import { cronMatches, validateCron } from "../../autotasks/native/cron.ts";
import { installRunManagerHost } from "./run-manager-host.ts";
import { LOOP_PAGE_NOTE, liveRuns, loopIdOfRun, loopRunActive, postRunNotice, projectGuardedFs, startRun } from "./run-manager.ts";
import { SCHEDULE_NOTICE_EVENT, pageRunStarting, startLoopSchedule, type ScheduleDeps } from "./loop-schedule.ts";
import { loadLoops } from "./store.ts";

const activeProject = (): string | null => projectStore.getSnapshot().project?.root ?? null;

export function realDeps(): ScheduleDeps {
  return {
    now: () => new Date(),
    storage: localStorage,
    projectRoot: activeProject,
    loadLoops: (root) => loadLoops(projectGuardedFs(createHostFs(), root, activeProject)),
    loopHasRun: (root, loopId) => liveRuns().some((r) => r.projectRoot === root && loopIdOfRun(r) === loopId),
    runActive: (root) => pageRunStarting(root) || loopRunActive(root) || liveRuns().some((r) => r.projectRoot === root && r.note === LOOP_PAGE_NOTE),
    start: (root, item) => { installRunManagerHost(); startRun(root, item, "full"); },
    tell: (message) => window.dispatchEvent(new CustomEvent(SCHEDULE_NOTICE_EVENT, { detail: { message } })),
    notify: postRunNotice,
    valid: validateCron,
    matches: cronMatches,
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id),
    onProjectChange: (fn) => {
      let last = activeProject();
      return projectStore.subscribe(() => { const now = activeProject(); if (now !== last) { last = now; fn(); } });
    },
  };
}

export function installLoopSchedule(deps: ScheduleDeps = realDeps()): () => void {
  return startLoopSchedule(deps);
}
