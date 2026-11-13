// Starts the one desktop scheduler for the open project (mounted by the shell, so a schedule fires while any section is
// open). Wires the scheduler core to the registry runner, the custom-task runner, the shared Auto Task lock, the Loop's
// write-run check and the two run histories.
import { core } from "../shell/runtime";
import { invokeHost } from "../shell/host";
import { changedPathArgs } from "../loop/native/worktree-run.ts";
import { createHostFs } from "../explorer/fs";
import { notifyTask } from "../shell/notify/notify";
import { tryAcquireAutoTask, releaseAutoTask } from "../autotasks/native/lock.ts";
import { runCustomTask } from "../autotasks/native/run-custom.ts";
import { appendCustomRun } from "../autotasks/native/custom-schedule.ts";
import { normaliseProjectRoot, type CustomAutoTask } from "../autotasks/native/custom.ts";
import { liveRuns } from "../loop/native/run-manager.ts";
import { taskById } from "./model.ts";
import { loadTaskState } from "./store.ts";
import { hasLinkedRepo, runRegisteredTask } from "./run-registered.ts";
import { appendTaskRun } from "./run-history.ts";
import { startTaskScheduler, type ScheduledItem, type ScheduledOutcome, type ScheduledRecord } from "./schedule.ts";

async function runCustom(task: CustomAutoTask, root: string): Promise<ScheduledOutcome> {
  const result = await runCustomTask(task, {
    request: (path, init) => core.request(path, init as never),
    workRoot: () => invokeHost<string>("loop_work_root"),
    // A scheduled task can outlive a project switch: both calls name the project it started in, and the host refuses
    // once another project is active (it would otherwise revert that project's uncommitted edits).
    changedPaths: async () => { try { return await invokeHost<string[]>("loop_changed_paths", changedPathArgs(null, root)); } catch { return null; } },
    revert: async (paths, created) => { await invokeHost("loop_revert_paths", { paths, created, ...changedPathArgs(null, root) }); },
  });
  const firstLine = result.reply.trim().split("\n")[0]?.slice(0, 260) ?? "";
  const summary = `${firstLine || result.error || (result.ok ? "completed" : "failed")}${result.writes.length ? ` (left: ${result.writes.join(", ")})` : ""}`.slice(0, 300);
  return { ok: result.ok, summary, ...(result.paused ? { code: "PAUSED_BY_LIMITS" } : {}) };
}

function record(rec: ScheduledRecord): void {
  const ok = rec.status === "ok";
  const durationSeconds = Math.max(0, Math.round((Date.now() - Date.parse(rec.at)) / 1000));
  if (rec.item.kind === "custom") {
    const task = rec.item.task;
    appendCustomRun({ id: crypto.randomUUID(), taskId: task.id, task: task.name, projectRoot: rec.projectRoot, at: rec.at, ok, summary: rec.summary, trigger: "cron" });
  } else {
    const label = taskById(rec.item.id)?.label ?? rec.item.id;
    appendTaskRun({ id: crypto.randomUUID(), taskId: rec.item.id, task: label, at: rec.at, ok, ...(rec.status === "skipped" ? { skipped: true } : {}), summary: rec.summary, durationSeconds });
  }
  if (rec.status !== "skipped") void notifyTask("autotask", ok);
}

async function run(item: ScheduledItem, root: string): Promise<ScheduledOutcome> {
  if (item.kind === "custom") return runCustom(item.task, root);
  const config = loadTaskState(root).configs[item.id];
  return runRegisteredTask(item.id, {
    projectRoot: root,
    promptOverride: config?.promptOverride ?? null,
    scheduled: true,
    core,
    fs: createHostFs(),
    log: () => undefined,
  });
}

/** Starts the scheduler for `projectRoot`; the returned function stops it. */
export function startDesktopScheduler(projectRoot: string): () => void {
  const normalised = normaliseProjectRoot(projectRoot);
  return startTaskScheduler(projectRoot, {
    now: () => new Date(),
    hasRepo: hasLinkedRepo,
    // A Loop-page run is external to the manager but still writes this project; it counts too.
    writeRunLive: () => liveRuns().some((r) => normaliseProjectRoot(r.projectRoot) === normalised),
    acquire: tryAcquireAutoTask,
    release: releaseAutoTask,
    run,
    record,
  });
}
