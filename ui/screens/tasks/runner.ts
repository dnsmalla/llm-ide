// Desktop execution adapter for the task registry. A shell task is one Loop stage (the same `runOneStage` the
// Loop and Factory use); a core-route or agent task is the core's `POST /kb/tasks/:id/run`; a desktop-action is
// a host/Factory/Ship action the Node core cannot run. No prompt is ever composed here: an agent task's prompt
// lives in the registry and is sent by the core.
import type { FsApi } from "../explorer/fs";
import type { Issue } from "../issues/issues-model.ts";
import type { CoreClient } from "../shell/core";
import type { LoopDefinition, LoopStage, LoopStageKind } from "../loop/native/model.ts";
import { faultPathsFromOutput, reopenFault } from "../loop/native/regression.ts";
import { runOneStage, type StageExecContext } from "../loop/native/stage-exec.ts";
import { resolveTaskId, taskById } from "./model.ts";
import { selectNextReadyIssue } from "./select-issues.ts";
import type { RunnerKind, TaskDef, TaskStageDef } from "./types.ts";

export interface TaskActions {
  /** Start one Factory run per issue id (the Factory's own path, also used by the bus). */
  startFactory?(issueIds: readonly string[], projectRoot: string): Promise<{ runIds: string[] }>;
  /** Card keys already on the Factory board; an issue with one is never started twice. */
  factoryItemKeys?(projectRoot: string): Promise<ReadonlySet<string>>;
  /** Whether Settings → Repositories maps the issue's repository to a clone inside this project (else its run cannot start). */
  issueRunnableHere?(issue: { provider: string; repo: string }, projectRoot: string): boolean;
  /** Open the pending Factory run (passed, unshipped, on a card) on the board; never ships. null = none waiting. */
  reviewPendingMerge?(projectRoot: string, runId: string | null): Promise<{ runId: string; reviewed: boolean } | null>;
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
  /** Task args from the config (never a prompt or a path). */
  args?: Record<string, unknown>;
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
    inputPath: "",
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
      stageDelaySeconds: 2,
      refactorBatchesPerRun: null, maxCostUsd: null,
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

type CoreTaskAnswer = Partial<TaskResult> & { ok?: unknown; summary?: unknown; output?: unknown; code?: unknown };

async function runCore(task: TaskDef, ctx: TaskRunContext): Promise<TaskResult> {
  const runner = task.runner?.kind === "agent" ? "agent" : "core-route";
  try {
    const answer = await ctx.core.request<CoreTaskAnswer>(`/kb/tasks/${encodeURIComponent(task.id)}/run`, {
      method: "POST",
      body: { ...(ctx.projectId ? { projectId: ctx.projectId } : {}), args: ctx.args ?? {} },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!answer || typeof answer !== "object") throw new TaskRunError("TASK_BAD_ANSWER", "The core returned no task result.");
    return {
      taskId: task.id,
      ok: answer.ok === true,
      runner,
      summary: typeof answer.summary === "string" ? answer.summary : answer.ok === true ? "completed" : "failed",
      output: typeof answer.output === "string" ? answer.output : "",
      changedPaths: Array.isArray(answer.changedPaths) ? answer.changedPaths.filter((p): p is string => typeof p === "string") : [],
      warnings: Array.isArray(answer.warnings) ? answer.warnings.filter((p): p is string => typeof p === "string") : [],
      ...(typeof answer.code === "string" ? { code: answer.code } : {}),
    };
  } catch (err) {
    if (err instanceof TaskRunError) throw err;
    const code = typeof (err as { code?: unknown })?.code === "string" ? String((err as { code: string }).code) : "TASK_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    return { taskId: task.id, ok: false, runner, summary: message, output: "", changedPaths: [], warnings: [], code };
  }
}

async function runDesktopAction(task: TaskDef, ctx: TaskRunContext): Promise<TaskResult> {
  const action = task.runner?.action;
  if (action === "factory.start") {
    const start = ctx.actions.startFactory;
    if (!start) throw new TaskRunError("TASK_NOT_AVAILABLE", "Open a project with the Factory on to start an issue run.");
    const listed = await ctx.core.request<{ issues?: Issue[] }>("/kb/issues?state=open", { method: "GET" });
    const taken = (await ctx.actions.factoryItemKeys?.(ctx.projectRoot)) ?? new Set<string>();
    // The core lists the issues of every repository; one that is not mapped to a clone in THIS project would only
    // add an unrelated card and fail its run.
    const here = ctx.actions.issueRunnableHere;
    const candidates = (listed.issues ?? []).filter((i) => !here || here({ provider: i.provider, repo: i.repo }, ctx.projectRoot));
    const issue = selectNextReadyIssue(candidates, taken);
    if (!issue) {
      return { taskId: task.id, ok: false, runner: "desktop-action", summary: "No ready issue.", output: "", changedPaths: [], warnings: [], code: "NO_READY_ISSUE" };
    }
    const { runIds } = await start([issue.id], ctx.projectRoot);
    return {
      taskId: task.id,
      ok: runIds.length > 0,
      runner: "desktop-action",
      summary: `Started Factory run for issue #${issue.number ?? issue.id}.`,
      output: runIds.join("\n"),
      changedPaths: [],
      warnings: [],
    };
  }
  if (action === "factory.ship-review") {
    const review = ctx.actions.reviewPendingMerge;
    if (!review) throw new TaskRunError("TASK_NOT_AVAILABLE", "Open a project with the Factory on to review a run.");
    const opened = await review(ctx.projectRoot, null);
    if (!opened) {
      return { taskId: task.id, ok: false, runner: "desktop-action", summary: "No Factory run is waiting for review.", output: "", changedPaths: [], warnings: [], code: "NO_PENDING_RUN" };
    }
    return {
      taskId: task.id,
      ok: true,
      runner: "desktop-action",
      summary: `Opened the Factory run ${opened.runId} for review. Ship is a separate click.`,
      output: opened.runId,
      changedPaths: [],
      warnings: [],
    };
  }
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
    case "agent": return runCore(task, ctx);
    case "desktop-action": return runDesktopAction(task, ctx);
    default: throw new TaskRunError("TASK_BAD_RUNNER", `Task "${task.id}" has an unknown runner.`);
  }
}
