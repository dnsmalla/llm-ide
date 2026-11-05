import { core } from "../../shell/runtime";
import { invokeHost } from "../../shell/host";
import { runCustomTask } from "./run-custom.ts";
import { runDueCustomTasks } from "./custom-schedule.ts";
export { CUSTOM_RUNS_EVENT, CUSTOM_RUNS_KEY, appendCustomRun, customTasksDue, readCustomRuns, runDueCustomTasks, type CustomTaskRun, type DueTaskDeps } from "./custom-schedule.ts";

/** Start the background tick. Returns a stop function; safe to mount once in the shell. */
export function startCustomTaskScheduler(projectRoot: string | null, intervalMs = 30_000): () => void {
  if (typeof window === "undefined") return () => {};
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    await runDueCustomTasks(projectRoot, {
      run: (task) => runCustomTask(task, {
        request: (path, init) => core.request(path, init as never),
        workRoot: () => invokeHost<string>("loop_work_root"),
        changedPaths: async () => { try { return await invokeHost<string[]>("loop_changed_paths"); } catch { return null; } },
        revert: async (paths, created) => { await invokeHost("loop_revert_paths", { paths, created }); },
      }),
      shouldStop: () => stopped,
    });
  };
  const timer = window.setInterval(() => { void tick(); }, intervalMs);
  const onVisible = () => { if (document.visibilityState === "visible") void tick(); };
  document.addEventListener("visibilitychange", onVisible);
  void tick();
  return () => { stopped = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
}
