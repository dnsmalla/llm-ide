// Desktop execution adapter for the task registry. A shell task is one Loop stage (the same `runOneStage` the
// Loop and Factory use); a core-route or agent task is the core's `POST /kb/tasks/:id/run`; a desktop-action is
// a host/Factory/Ship action the Node core cannot run. No prompt is ever composed here: an agent task's prompt
// lives in the registry and is sent by the core.
import type { FsApi } from "../explorer/fs";
import type { CoreClient } from "../shell/core";
import type { LoopDefinition, LoopStage, LoopStageKind } from "../loop/native/model.ts";
import { faultPathsFromOutput, reopenFault } from "../loop/native/regression.ts";
import { runOneStage, type StageExecContext } from "../loop/native/stage-exec.ts";
import { resolveTaskId, taskById } from "./model.ts";
import type { RunnerKind, TaskDef, TaskStageDef } from "./types.ts";

export interface TaskActions {
  /** Start one Factory run per issue. Implemented by the Auto Tasks/Factory wiring (Task 7). */
  startFactory?(issueIds: readonly string[], projectRoot: string): Promise<{ runIds: string[] }>;
  /** Open the latest passed Factory run for review; never ships. Implemented in Task 8. */
  reviewPendingMerge?(projectRoot: string, runId: string | null): Promise<{ runId: string | null; reviewed: boolean }>;
}

export interface TaskRunContext {
  projectRoot: string;
  /** The registered project id when the core knows it; the core route uses it for authority. */
  projectId?: string;
  core: Pick<CoreClient, "request">;
  host: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  fs: FsApi;
  log(line: string): void;
  signal?: AbortSignal;
  approvalToken(stage: LoopStage): Promise<string | null>;
  changedPaths(): Promise<string[] | null>;
  revert(paths: string[], created: string[]): Promise<void>;
  actions: TaskActions;
  /** Custom tasks are dynamic (their prompt belongs to the user); the scheduler passes them here. */
  extraTasks?: ReadonlyMap<string, TaskDef>;
}

export interface TaskResult {
  taskId: string;
  ok: boolean;
  runner: RunnerKind;
  summary: string;
  output: string;
  changedPaths: string[];
  warnings: string[];
  code?: string;
}

export class TaskRunError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaskRunError";
    this.code = code;
  }
}

function shellStage(task: TaskDef, stageDef: TaskStageDef): LoopStage {
  return {
    id: task.id,
    name: typeof stageDef.name === "string" ? stageDef.name : task.label,
    kind: stageDef.kind as LoopStageKind,
    command: typeof stageDef.command === "string" ? stageDef.command : null,
    order: 0,
    skillId: null,
    targetPath: null,
    outputPath: null,
    prompt: null,
    isDefault: false,
    enabled: true,
    defaultKey: null,
    severity: stageDef.severity === "advisory" ? "advisory" : "blocking",
    timeoutSeconds: task.runner?.timeoutSeconds ?? null,
    detectedCommand: null,
    check: null,
    testOp: null,
    graphOp: null,
    allowsRepair: stageDef.allowsRepair !== false,
    runOnce: false,
    defaultRevision: null,
    disabledByDetection: null,
    raw: null,
    taskId: task.id,
  };
}

function shellLoop(task: TaskDef, stage: LoopStage): LoopDefinition {
  return {
    id: task.id,
    name: task.label,
    isPrimary: false,
    goal: null,
    acceptanceCriteria: null,
    scopeGlobs: [],
    defaultKey: null,
    runsOnSchedule: false,
    config: {
      stages: [stage],
      maxIterations: 1,
      consecutiveFailureStop: 1,
      wallClockBudgetSeconds: null,
      pauseTimeoutSeconds: 0,
      maxRepairsPerStage: 0,
      repairModel: null,
      protectedPathPolicy: "off",
      writeSummaryNote: false,
      extraProtectedGlobs: [],
      useWorktreesForConcurrentRuns: false,
      alwaysUseWorktree: false,
      openMergeRequest: false,
      refactorBatchesPerRun: null,
    },
  };
}

async function runShell(task: TaskDef, ctx: TaskRunContext): Promise<TaskResult> {
  const stageDef = task.runner?.stage;
  if (!stageDef) throw new TaskRunError("TASK_BAD_STAGE", `Task "${task.id}" is a shell task without stage metadata.`);
  const stage = shellStage(task, stageDef);
  let runRoot = ctx.projectRoot;
  try { runRoot = (await ctx.host<string>("loop_work_root")) || ctx.projectRoot; } catch { runRoot = ctx.projectRoot; }
  const exec: StageExecContext = {
    projectRoot: ctx.projectRoot,
    runId: null,
    runRoot,
    fs: ctx.fs,
    host: ctx.host,
    core: ctx.core,
    log: ctx.log,
    approvalToken: ctx.approvalToken,
    signal: ctx.signal,
    isCancelled: () => ctx.signal?.aborted === true,
    markCancelled: () => {},
  };
  const result = await runOneStage(exec, stage, shellLoop(task, stage), [], { reason: null, isError: false });
  if (!result.ok && stage.kind === "regressionSweep") {
    // Same post-failure rule as the Loop screen: a fixed fault that no longer verifies is reopened.
    for (const rel of faultPathsFromOutput(result.output)) await reopenFault(ctx.fs, rel).catch(() => false);
  }
  return {
    taskId: task.id,
    ok: result.ok,
    runner: "shell",
    summary: result.output.split("\n").find((line) => line.trim() !== "") ?? (result.ok ? "completed" : "failed"),
    output: result.output,
    changedPaths: [],
    warnings: [],
    ...(result.ok ? {} : { code: "TASK_FAILED" }),
  };
}

async function runDesktopAction(task: TaskDef, _ctx: TaskRunContext): Promise<TaskResult> {
  const action = task.runner?.action;
  throw new TaskRunError("TASK_NOT_IMPLEMENTED", `Desktop action "${action ?? "(none)"}" for task "${task.id}" is not wired yet.`);
}

/** Resolve a task id/alias and dispatch to its runner. Throws typed `TaskRunError`s for unknown/unavailable tasks. */
export async function runTask(taskId: string, ctx: TaskRunContext): Promise<TaskResult> {
  const canonical = resolveTaskId(taskId);
  const task = canonical !== null
    ? taskById(canonical) ?? ctx.extraTasks?.get(canonical) ?? null
    : ctx.extraTasks?.get(taskId) ?? null;
  if (!task) throw new TaskRunError("UNKNOWN_TASK", `Unknown task "${taskId}".`);
  if (task.availability.status !== "available") {
    throw new TaskRunError("TASK_NOT_AVAILABLE", task.availability.reason ?? `Task "${task.id}" is ${task.availability.status}.`);
  }
  const runner = task.runner;
  if (!runner) throw new TaskRunError("TASK_NOT_AVAILABLE", `Task "${task.id}" has no runner.`);
  switch (runner.kind) {
    case "shell": return runShell(task, ctx);
    case "core-route":
    case "agent":
      throw new TaskRunError("TASK_NOT_IMPLEMENTED", `Task "${task.id}" needs the core task route, which is not wired yet.`);
    case "desktop-action": return runDesktopAction(task, ctx);
    default: throw new TaskRunError("TASK_BAD_RUNNER", `Task "${task.id}" has an unknown runner.`);
  }
}
