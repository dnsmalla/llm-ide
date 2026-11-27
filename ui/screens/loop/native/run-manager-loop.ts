// A non-Factory loop run inside the run manager: the same steps the Loop page runs today (start, driver, issue trail,
// archive, finish), through the same functions (run-start.ts, loop-drivers.ts, run-finish.ts). Nothing here owns state:
// the manager passes a `LoopRunContext` (its log, cancel flag and worktree id) and a subset of its deps.
import type { FsApi } from "../../explorer/fs";
import { isManualOnly, loadLoops, batchRollbackReason } from "./store.ts";
import { readRecentRuns, runTrigger } from "./history.ts";
import { readinessCopyPath } from "./readiness-copy.ts";
import { FACTORY_INTAKE_SKILL, isFactoryLoop } from "./factory.ts";
import { loopUsesInputPath, normalizeInputPath } from "./input-path.ts";
import { runSummaryBody, stepCommentBody, summarizeSteps, trailForRun, type TrailDeps } from "./issue-trail.ts";
import { isSetupStage, markSetupDone, setupNeeded } from "./loop-setup.ts";
import { lastShipUrl } from "./loop-branch.ts";
import { loopbackLogLine } from "./loopback.ts";
import { DEFAULT_DRIVERS, runLoopWithDriver, withBaselineFor, type DriverFns } from "./loop-drivers.ts";
import { isNativeRunnable, type LoopDefinition } from "./model.ts";
import { faultPathsFromOutput, reopenFault } from "./regression.ts";
import { isOneItemRun } from "./run-command.ts";
import { copyStateBackIfMissed } from "./run-end.ts";
import { finishLoopRun, type ManualShip } from "./run-finish.ts";
import { prepareLoopRun } from "./run-start.ts";
import { runStatusCode, type LoopRunOutcome, type ProgressEvent as RunProgressEvent, type RunnerDeps } from "./runner.ts";
import { shipTarget, type WorktreeDiff } from "./ship-model.ts";
import { createModelTracker } from "./step-model.ts";
import { createStageDeps, type CoreFetch, type HostInvoke, type StageExecContext } from "./stage-exec.ts";
import { writeRunArchive } from "./summary.ts";
import { postSignal, runSignalPayload } from "./improve/signals.ts";
import { changedPathArgs, repoPrefixFor, runRoot, runsInWorktree, type RunInfo } from "./worktree-run.ts";
import type { LoopApprovalStatus } from "./approvals.ts";
import type { RepoConfig } from "../../settings/repo-config.ts";
import type { LoopRunIndexEntry } from "./history.ts";
import type { WorkItem } from "./factory.ts";
import type { FinishedRunShip } from "./run-manager-host.ts";

/** What starts a non-Factory loop run: the loop (read from loop.json when the run starts) and the board's per-run overrides. */
export interface LoopRunRequest {
  loopId: string;
  /** The task of a "one item I name" loop. */
  command?: string;
  /** A per-run input folder, never written to loop.json. */
  inputPath?: string;
  /** A scheduled run never opens an approval dialog: it needs a grant that already covers the loop's commands. */
  scheduled?: boolean;
}

/** A finished run that needs a person (held for review, or its ship was blocked): what the Loop page's Ship panel opens with. */
export interface LoopManualShip {
  info: RunInfo;
  item: WorkItem;
  entry: LoopRunIndexEntry;
  diff: WorktreeDiff | null;
  reviewedPatchId: string | null;
  mergedMr: string | null;
  /** The loop's name (the MR title). */
  processName: string;
}

/** What a run that reached its record reports to the manager. */
export interface LoopRunFinished {
  outcome: LoopRunOutcome;
  manualShip: LoopManualShip | null;
}

/** The host-only pieces a loop run needs on top of the run manager's own deps. */
export interface LoopRunHost {
  approvalStatus(loopId: string): Promise<LoopApprovalStatus>;
  refreshApproval(loopId: string): Promise<void>;
  post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }>;
  readRepoConfig(): RepoConfig;
  /** The desktop notification of a finished run. */
  notify?(passed: boolean): void;
  /** A Self-Heal incident for a run that broke (not a stage verdict). */
  reportIncident?(message: string): void;
  /** Replaces a driver function (tests). */
  drivers?: Partial<DriverFns>;
}

/** The run manager's deps a loop run reads. */
export interface LoopRunDeps {
  host: HostInvoke;
  core: CoreFetch;
  approve(loopId: string): Promise<string | null>;
  createStageDeps: typeof createStageDeps;
  runLoop: DriverFns["plain"];
  appendRecord(fs: FsApi, entry: LoopRunIndexEntry, record: Record<string, unknown>): Promise<void>;
  copyReadiness(fs: FsApi, runRootPrefix: string, runId: string, at: Date): Promise<boolean>;
  autoShip?(e: FinishedRunShip): Promise<string>;
  now(): Date;
  rand(): number;
  newId(): string;
  loopRun?: LoopRunHost;
}

/** The manager's side of one run. */
export interface LoopRunContext {
  fs: FsApi;
  projectRoot: string;
  /** The manager's run id (unique per run, unlike the loop's shared worktree id). */
  runId: string;
  request: LoopRunRequest;
  /** Appends to the live log and the run-log file. */
  log(line: string): void;
  /** The run's outcome line for the board's notice. */
  notice(text: string): void;
  /** Ends the run without a record and keeps the message as the run's notice. */
  refuse(message: string): void;
  isCancelled(): boolean;
  markCancelled(): void;
  signal: AbortSignal;
  holdWhilePaused(timeoutSeconds?: number): Promise<"ok" | "timedOut">;
  /** The worktree run id host calls carry (null: no worktree); lets Stop reach `loop_cancel`. */
  onPrepared(worktreeRunId: string | null): void;
  /** The worktree exists: start mirroring the log to its file. */
  startLogFile(): void;
  /** The run's real config is known: the manager starts its typed progress (step count, round budget). */
  onConfig(config: LoopDefinition["config"]): void;
  /** One runner event, for the manager's typed progress. */
  onProgress(e: RunProgressEvent): void;
  /** The model the running agent step uses (null: none). */
  onModel(label: string | null): void;
  /** The run_finished signal was posted. */
  onSignalPosted(): void;
  /** Waits for the run's project to be open, even when the run was cancelled: the end writes the record, archive and state into it. */
  holdForProject(): Promise<void>;
  /** The run reached its record. */
  onFinished(f: LoopRunFinished): void;
}

/** The issue trail goes through the core; Settings → Repositories decides what is allowed. */
function trailDeps(host: LoopRunHost, log: (line: string) => void): TrailDeps {
  return {
    request: (path, body) => host.post(path, body, 15_000),
    allowed: (provider, op) => host.readRepoConfig().operations[provider].includes(op),
    onError: log,
  };
}

/** The loop to run: read from loop.json now, with the board's input-folder override applied. A refusal is a message. */
async function resolveLoop(c: LoopRunContext): Promise<LoopDefinition | { refusal: string }> {
  const loaded = await loadLoops(c.fs);
  if (loaded.kind !== "ok") return { refusal: `The loops could not be loaded: ${loaded.kind === "corrupt" ? loaded.message : "no loop file yet."}` };
  const target = loaded.store.loops.find((l) => l.id === c.request.loopId);
  if (!target) return { refusal: "That loop no longer exists." };
  if (isFactoryLoop(target)) return { refusal: "Use the Factory board's + Add to start a Factory run." };
  if (c.request.inputPath === undefined || !loopUsesInputPath(target)) return target;
  const n = normalizeInputPath(c.request.inputPath);
  return "error" in n ? { refusal: n.error } : { ...target, inputPath: n.path };
}

/** The checks the Loop page makes before it asks for approval. null = the run may start. */
function startRefusal(target: LoopDefinition, c: LoopRunContext, oneItem: boolean, command: string | undefined): string | null {
  const scheduled = c.request.scheduled === true;
  if (oneItem && !command) return scheduled ? `“${target.name}” is set to one item you name; the schedule skipped it.` : `“${target.name}” is set to one item you name: type the task and press ▶ Run.`;
  const unsupported = target.config.stages.find((s) => s.enabled && !isNativeRunnable(s));
  if (unsupported) return `“${unsupported.name}” is a ${unsupported.kind} stage; it cannot run yet.`;
  if (scheduled && isManualOnly(target)) return `“${target.name}” applies code and is manual-only; the schedule skipped it.`;
  return batchRollbackReason(target);
}

/**
 * Runs one non-Factory loop to its record. Returns normally for every ending (passed, failed, cancelled, refused); a
 * throw is a run that broke and is reported by the manager. A refusal before the worktree exists writes no record.
 */
export async function runLoopRequest(d: LoopRunDeps, c: LoopRunContext): Promise<void> {
  const host = d.loopRun;
  if (!host) { c.refuse("The loop run path is not configured; the run did not start."); return; }
  const resolved = await resolveLoop(c);
  if ("refusal" in resolved) { c.refuse(resolved.refusal); return; }
  const target = resolved;
  const command = c.request.command?.trim() || undefined;
  const oneItem = isOneItemRun(target.config.workMode, command, false);
  const refusal = startRefusal(target, c, oneItem, command);
  if (refusal) { c.refuse(refusal); return; }
  const { projectRoot, fs } = c;
  const workRoot = await d.host<string>("loop_work_root").catch(() => null);
  const workRelative = workRoot && workRoot.startsWith(`${projectRoot}/`) ? workRoot.slice(projectRoot.length + 1) : "";
  let starting = false;
  const result = await prepareLoopRun({
    host: (name, args) => d.host(name, args),
    folderExists: (path) => fs.list(path).then(() => true, () => false),
    approveLoop: async (loopId) => {
      const token = await d.approve(loopId);
      return token === null ? null : { token, expiresAtMs: 0, stageIds: [], faultCount: 0 };
    },
    approvalStatus: host.approvalStatus,
    refreshApproval: host.refreshApproval,
    lastShip: async (loopId) => lastShipUrl(fs, await readRecentRuns(fs), loopId),
    post: host.post,
    readRepoConfig: host.readRepoConfig,
    newRunId: () => c.runId,
    setupNeeded: (prefix, setupCommand) => setupNeeded(fs, prefix, setupCommand),
    isUnmounted: () => c.isCancelled(),
    beginStarting: () => { if (starting) return false; starting = true; return true; },
    endStarting: () => { starting = false; },
    closePicker: () => undefined,
    log: c.log,
  }, { target, scheduled: c.request.scheduled === true, start: null, command, oneItem, useWorktree: runsInWorktree(target.config, false), projectRoot, workRoot, workRelative });
  if (!result.ok) {
    if (result.notice !== null) c.refuse(result.notice); else c.log("Run cancelled before it started.");
    return;
  }
  const { info: activeRun, reusedWorktree, mergedMr, leftoverFiles, approvalToken, runConfig } = result;
  if (result.notice !== null) c.log(result.notice);
  c.onPrepared(activeRun?.runId ?? null);
  c.startLogFile();
  for (const line of result.logLines) c.log(line);
  await runPrepared(d, host, c, target, { activeRun, reusedWorktree, mergedMr, leftoverFiles, approvalToken, runConfig, oneItem, command, workRoot });
}

interface Prepared {
  activeRun: RunInfo | null;
  reusedWorktree: boolean;
  mergedMr: string | null;
  leftoverFiles: number | null;
  approvalToken: string | null;
  runConfig: LoopDefinition["config"];
  oneItem: boolean;
  command: string | undefined;
  workRoot: string | null;
}

async function runPrepared(d: LoopRunDeps, host: LoopRunHost, c: LoopRunContext, target: LoopDefinition, p: Prepared): Promise<void> {
  const { fs, projectRoot, runId } = c;
  const { activeRun, runConfig } = p;
  const started = d.now().getTime();
  const archiveLog: string[] = p.oneItem ? [`Task: ${p.command}`] : [];
  const prefix = activeRun ? repoPrefixFor(projectRoot, activeRun.worktree) : "";
  const marker = activeRun ? `${prefix}/.factory/RUN.json` : null;
  let stateSavedBack = false;
  try {
    c.onConfig(runConfig);
    const trailRepo = shipTarget({ repo: activeRun?.repo ?? p.workRoot ?? projectRoot }, host.readRepoConfig());
    const trail = await trailForRun(trailDeps(host, c.log), {
      item: null,
      // Only open a fresh repo issue when the loop opted in (config.issueTrail, default off).
      open: target.config.issueTrail === true,
      repo: trailRepo,
      process: target.name, runId, goal: target.goal, steps: target.config.stages.filter((st) => st.enabled).map((st) => st.name),
    });
    if (trail) c.log(`issue trail: ${trail.target.repo}#${trail.target.number}`);
    else if (!trailRepo) c.log(`issue trail: no issue — ${activeRun?.repo ?? p.workRoot ?? projectRoot} is not mapped in Settings → Repositories`);
    else c.log(`issue trail: no issue — ${trailRepo.provider} ${trailRepo.slug} could not be opened (see the line above)`);
    // The runner and the stage executor both log through this, so the run archive holds the whole log.
    const followLog = (line: string) => { archiveLog.push(line); c.log(line); };
    const models = createModelTracker(d.core, runConfig.repairModel);
    models.onChange(() => c.onModel(models.label()));
    const stageCtx: StageExecContext = {
      projectRoot, runId: activeRun?.runId ?? null, runRoot: runRoot(projectRoot, activeRun, p.workRoot), fs, host: d.host, core: d.core, log: followLog,
      approvalToken: async () => p.approvalToken, signal: c.signal, isCancelled: c.isCancelled, markCancelled: c.markCancelled,
      ...(p.oneItem && p.command ? { runCommand: p.command } : {}),
    };
    const runDeps: RunnerDeps = {
      ...withBaselineFor(d.createStageDeps(stageCtx, target), p.reusedWorktree),
      isCancelled: c.isCancelled,
      log: followLog,
      holdWhilePaused: c.holdWhilePaused,
      onProgress(e: RunProgressEvent) {
        c.onProgress(e);
        c.onModel(models.onEvent(e));
        if (!trail) return;
        if (e.type === "stage-result") trail.post(stepCommentBody({ process: target.name, stageName: e.stage.name, ok: e.ok, runId, mode: "loop", iteration: e.iteration, durationSeconds: e.durationMs / 1000, costUsd: e.costUsd }));
        else if (e.type === "stage-skipped") trail.post(stepCommentBody({ process: target.name, stageName: e.stage.name, ok: true, skipped: true, runId, mode: "loop", iteration: e.iteration }));
      },
    };
    const outcome = await runLoopWithDriver({
      target, runConfig, runDeps, activeRun, oneItem: p.oneItem, projectRoot, fs, host: d.host, batchLog: c.log, passesLog: followLog,
    }, { ...DEFAULT_DRIVERS, plain: d.runLoop, ...host.drivers });
    // The record, archive and state copy-back need the run's project open, and a cancelled run needs it too.
    await c.holdForProject();
    const settled = await settleOutcome(d, c, target, p, outcome, archiveLog, started, trail);
    const finished = await finishLoopRun({
      host: d.host,
      appendRecord: (entry, record) => d.appendRecord(fs, entry, record),
      removeMarker: marker ? () => fs.remove(marker) : null,
      readRuns: () => readRecentRuns(fs),
      setRuns: () => undefined,
      postRunFinished: (entry, record) => postSignal(d.core, { projectRoot, loopId: entry.loopId, kind: "run_finished", runId: entry.id, payload: () => runSignalPayload(entry, record) }),
      onSignalPosted: c.onSignalPosted,
      syncStateBack: async () => { if (!activeRun) return; await d.host("loop_worktree_state_sync", { runId: activeRun.runId, direction: "out" }); stateSavedBack = true; },
      ship: async (e) => (d.autoShip ? d.autoShip(e) : ""),
      now: () => d.now().getTime(),
      newId: () => d.newId(),
      log: c.log,
      setNotice: (text) => { c.log(text); c.notice(text); },
    }, {
      loop: target, outcome, started, trigger: runTrigger(c.request.scheduled === true), activeRun, start: null, projectRoot, runPrefix: prefix,
      leftoverFiles: p.leftoverFiles, mergedMr: p.mergedMr, changedPaths: settled.changedPaths, summaryPath: settled.summaryPath,
      needsDecision: null, gitRoot: () => runRoot(projectRoot, activeRun, p.workRoot),
    });
    // Held for review, or the shipper was blocked: the run's record carries it, and the Ship panel on the Loop page is the manual path.
    const ship = finished.manualShip;
    if (ship) c.log("Waiting for review: open this run on the Loop page to review its diff and ship it.");
    c.onFinished({ outcome, manualShip: ship && activeRun ? manualShipOf(ship, activeRun, target.name) : null });
  } finally {
    if (activeRun) await copyStateBackIfMissed({ syncStateBack: async () => { await d.host("loop_worktree_state_sync", { runId: activeRun.runId, direction: "out" }); } }, stateSavedBack);
    void host.refreshApproval(target.id).catch(() => undefined);
  }
}

function manualShipOf(ship: ManualShip, info: RunInfo, processName: string): LoopManualShip {
  return { info, item: ship.item, entry: ship.entry, diff: ship.diff, reviewedPatchId: ship.reviewedPatchId, mergedMr: ship.mergedMr, processName };
}

/** Everything the Loop page does between the driver and `finishLoopRun`: setup mark, changed paths, trail summary, reopened faults, readiness copy, archive, notification. */
async function settleOutcome(
  d: LoopRunDeps, c: LoopRunContext, target: LoopDefinition, p: Prepared, outcome: LoopRunOutcome,
  archiveLog: string[], started: number, trail: Awaited<ReturnType<typeof trailForRun>>,
): Promise<{ changedPaths: string[]; summaryPath: string | null }> {
  const { fs, projectRoot, runId } = c;
  const { activeRun } = p;
  const prefix = activeRun ? repoPrefixFor(projectRoot, activeRun.worktree) : "";
  const setupStage = target.config.stages.find((st) => isSetupStage(st));
  if (activeRun && setupStage && outcome.stages.some((o) => isSetupStage(o.stage) && o.ok)) await markSetupDone(fs, prefix, setupStage.command ?? "");
  if (!outcome.passed && !outcome.cancelled && outcome.failedStage && isSetupStage(outcome.failedStage)) outcome.statusSummary = `Setting up the project's dependencies (${setupStage?.command ?? "install"}) failed, so the run stopped before its other steps.${activeRun ? ` Branch ${activeRun.branch} is kept.` : ""}`;
  if (activeRun) c.log(`ran in system/loop-worktrees/${activeRun.runId} on branch ${activeRun.branch}; your main working tree was not touched`);
  let changedPaths: string[] = [];
  try { changedPaths = await d.host<string[]>("loop_changed_paths", changedPathArgs(activeRun?.runId ?? null, projectRoot)); } catch { changedPaths = []; }
  if (changedPaths.length) c.log(`changed paths: ${changedPaths.join(", ")}`);
  trail?.post(runSummaryBody({
    process: target.name, runId, statusCode: runStatusCode(outcome), statusSummary: outcome.statusSummary,
    steps: summarizeSteps(outcome.stages), changedFiles: changedPaths, durationSeconds: (d.now().getTime() - started) / 1000,
    costUsd: outcome.costUsd ?? null, mergeRequest: null,
  }));
  // Do not finish the run before the issue comments are actually posted.
  await trail?.idle();
  c.log(outcome.cancelled ? (c.isCancelled() ? "Loop cancelled." : `Loop aborted: ${outcome.statusSummary}`) : outcome.passed ? "Loop passed." : `Loop failed: ${outcome.statusSummary}`);
  if (!outcome.passed && !outcome.cancelled && outcome.loopback) c.log(loopbackLogLine(outcome.loopback));
  if (!outcome.cancelled && !outcome.passed && outcome.failedStage?.kind === "regressionSweep") {
    const failedRun = [...outcome.stages].reverse().find((o) => o.stage.kind === "regressionSweep" && !o.ok);
    let reopened = 0;
    for (const rel of faultPathsFromOutput(failedRun?.output ?? "")) if (await reopenFault(fs, rel)) reopened += 1;
    if (reopened > 0) c.log(`reopened ${reopened} fixed fault(s).`);
  }
  if (activeRun && outcome.stages.some((o) => o.stage.skillId === FACTORY_INTAKE_SKILL)) {
    const copyAt = new Date(started);
    try {
      const copied = await d.copyReadiness(fs, prefix, activeRun.runId, copyAt);
      c.log(copied ? `readiness report copied to ${readinessCopyPath(activeRun.runId, copyAt)}` : "no .factory/READINESS.md to copy");
    } catch (e) {
      c.log(`readiness copy failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let summaryPath: string | null = null;
  try {
    const dir = await writeRunArchive(fs, target, outcome, archiveLog, new Date(), prefix, target.defaultKey === "test" ? target.inputPath ?? "" : "");
    if (dir) {
      summaryPath = `${dir}/run.md`;
      c.log(`run archive: ${dir}/run.md`);
    } else c.log("run archive could not be written");
  } catch (e) { c.log(`run archive failed: ${e instanceof Error ? e.message : String(e)}`); }
  c.notice(outcome.cancelled ? (c.isCancelled() ? "The loop was cancelled." : outcome.statusSummary) : outcome.passed ? "The loop passed." : outcome.statusSummary);
  if (!outcome.cancelled) d.loopRun?.notify?.(outcome.passed);
  return { changedPaths, summaryPath };
}
