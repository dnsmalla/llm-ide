// The end of a Loop-page run, free of React: the diff read, the end rule, the run record and index row, the signal and
// the worktree end (run-end.ts). Every side effect goes through `FinishDeps`, so node tests drive the exact order.
import type { LoopDefinition } from "./model.ts";
import { isFactoryLoop, type WorkItem } from "./factory.ts";
import { iterationRecordsWithScores, type FactoryRunFields, type LoopRunIndexEntry } from "./history.ts";
import { loopbackRecord } from "./loopback.ts";
import { reviewModeOf, stepReviewRecords } from "./review.ts";
import { endWorktreeRun } from "./run-end.ts";
import type { FinishedRunShip } from "./run-manager-host.ts";
import { runStatusCode, type LoopRunOutcome } from "./runner.ts";
import { decodeWorktreeDiff, type WorktreeDiff } from "./ship-model.ts";
import { heldFields, runChanged, runEndAction, type HeldReason, type RunEnd, type RunInfo } from "./worktree-run.ts";

export type RunDiffSummary = { files: string[]; truncated: boolean; patchId: string | null; additions: number; deletions: number };

export interface RunRecordInput {
  id: string;
  loop: LoopDefinition;
  outcome: LoopRunOutcome;
  startedAt: string;
  durationSeconds: number;
  endedAt: string;
  trigger: string;
  activeRun: RunInfo | null;
  start: { item: WorkItem } | null;
  end: RunEnd | null;
  heldReason: HeldReason;
  mergedMr: string | null;
  changedPaths: string[];
  summaryPath: string | null;
  needsDecision: string | null;
  diffSummary: RunDiffSummary | null;
  gitRoot: string;
}

/** The index row and the full record of a finished run, exactly as the Loop page has always written them. */
export function buildRunEntryAndRecord(i: RunRecordInput): { entry: LoopRunIndexEntry & { factoryRunId?: string; factoryMode?: "full" }; record: Record<string, unknown> } {
  const { outcome, end, heldReason, activeRun, start } = i;
  const isFactory = isFactoryLoop(i.loop);
  // factoryRunId + factoryMode: the board finds a card's last run through these fields (the run manager writes them too).
  const entry: LoopRunIndexEntry & { factoryRunId?: string; factoryMode?: "full" } = {
    id: i.id, loopId: i.loop.id, loopName: i.loop.name, startedAt: i.startedAt, durationSeconds: i.durationSeconds, iterationsUsed: outcome.iterationsUsed,
    statusCode: runStatusCode({ ...outcome, awaitingReview: end === "hold" }),
    statusSummary: end === "discard" ? `${outcome.statusSummary} No changes.` : end === "hold" ? `${outcome.statusSummary} ${heldReason === "human" ? "Waiting for your review." : "Held: its worktree had files an earlier run left; open the run (Open run log & plan) and review its diff in the Ship panel before shipping."}` : outcome.statusSummary,
    trigger: i.trigger,
    ...(activeRun && isFactory ? { factoryRunId: activeRun.runId, factoryMode: "full" as const } : {}),
  };
  const factoryFields: FactoryRunFields = {
    workItem: start ? { source: start.item.source, id: start.item.id, title: start.item.title } : null,
    worktree: activeRun ? { runId: activeRun.runId, branch: activeRun.branch, baseCommit: activeRun.baseCommit, repo: activeRun.repo } : null,
    ship: null,
    needsDecision: i.needsDecision,
    diffSummary: i.diffSummary,
  };
  const stages = outcome.stages.map((o) => ({ stageName: o.stage.name, severity: o.stage.severity, costUsd: o.usage?.costUsd ?? null, run: { exitCode: o.ok ? 0 : 1, stdout: o.output, stderr: "", timedOut: false, durationMs: 0 } }));
  const record = {
    ...entry, endedAt: i.endedAt, gitRoot: i.gitRoot, config: i.loop.config, changedPaths: i.changedPaths, summaryPath: i.summaryPath, ...factoryFields,
    ...(end === "hold" ? heldFields(i.mergedMr, heldReason) : {}), ...stepReviewRecords(outcome.stepReviews), ...loopbackRecord(outcome.loopback),
    costUsd: outcome.costUsd ?? stages.reduce((n, st) => n + (st.costUsd ?? 0), 0), stages, iterations: iterationRecordsWithScores(outcome.iterations),
  };
  return { entry, record };
}

export interface FinishDeps {
  host<T>(command: string, args: Record<string, unknown>): Promise<T>;
  appendRecord(entry: LoopRunIndexEntry, record: Record<string, unknown>): Promise<void>;
  /** Removes the run marker once the record is on disk; null when the run wrote none. */
  removeMarker: (() => Promise<void>) | null;
  readRuns(): Promise<LoopRunIndexEntry[]>;
  setRuns(runs: LoopRunIndexEntry[]): void;
  /** The run_finished signal; null when there is no project to post it for. */
  postRunFinished: ((entry: LoopRunIndexEntry, record: Record<string, unknown>) => Promise<void>) | null;
  onSignalPosted(): void;
  /** The screen sets its "state was copied back" flag inside this, so its `finally` knows not to copy again. */
  syncStateBack(): Promise<void>;
  ship(e: FinishedRunShip): Promise<string>;
  now(): number;
  newId(): string;
  log(line: string): void;
  setNotice(text: string): void;
}

export interface FinishInput {
  loop: LoopDefinition;
  outcome: LoopRunOutcome;
  started: number;
  trigger: string;
  activeRun: RunInfo | null;
  start: { item: WorkItem } | null;
  projectRoot: string;
  runPrefix: string;
  leftoverFiles: number | null;
  mergedMr: string | null;
  changedPaths: string[];
  summaryPath: string | null;
  needsDecision: string | null;
  gitRoot: () => string;
}

export interface ManualShip { item: WorkItem; entry: LoopRunIndexEntry; diff: WorktreeDiff | null; reviewedPatchId: string | null; mergedMr: string | null }
export interface FinishResult { manualShip: ManualShip | null }

/**
 * The end of one run, in this order: ONE diff read (ShipPanel gets it as a prop; two parallel reads race on the worktree's
 * index.lock), the end rule, then for a worktree run the state copy-back, the record (before any ship, so ShipPanel's
 * setRunRecordShip finds it) and the end rule's action; for any other run the record, the signal and, for a Factory run
 * started here, the Ship offer.
 */
export async function finishLoopRun(d: FinishDeps, i: FinishInput): Promise<FinishResult> {
  const { loop, outcome, activeRun } = i;
  const isFactory = isFactoryLoop(loop);
  const startedAt = new Date(i.started).toISOString();
  const worktreeDiff = activeRun
    ? await d.host<unknown>("loop_worktree_diff", { runId: activeRun.runId }).then(decodeWorktreeDiff).catch(() => null)
    : null;
  const diffSummary = worktreeDiff ? { files: worktreeDiff.files, truncated: worktreeDiff.truncated, patchId: worktreeDiff.patchId || null, additions: worktreeDiff.additions, deletions: worktreeDiff.deletions } : null;
  // One end-of-run rule for every loop but the Factory (which has its own board): a passed run with changes opens its
  // draft MR, a passed run with none is removed, anything else keeps its branch. Nothing is removed on doubt.
  const end = activeRun && !isFactory
    ? runEndAction({ passed: outcome.passed, cancelled: outcome.cancelled === true, changed: runChanged(worktreeDiff), humanReview: reviewModeOf(loop.config) === "human", leftoverFiles: i.leftoverFiles, openMergeRequest: loop.config.openMergeRequest })
    : null;
  // Leftovers win over Human: an earlier run's edits must be seen in the diff, never shipped with one click.
  const heldReason: HeldReason = i.leftoverFiles === null || (i.leftoverFiles ?? 0) > 0 ? "leftoverFiles" : "human";
  const { entry, record } = buildRunEntryAndRecord({
    id: d.newId(), loop, outcome, startedAt, durationSeconds: (d.now() - i.started) / 1000, endedAt: new Date(d.now()).toISOString(), trigger: i.trigger,
    activeRun, start: i.start, end, heldReason, mergedMr: i.mergedMr, changedPaths: i.changedPaths, summaryPath: i.summaryPath, needsDecision: i.needsDecision, diffSummary, gitRoot: i.gitRoot(),
  });
  // Awaited: Ship's record update (setRunRecordShip) needs the record on disk, so the panel opens only after it.
  const saveRecord = () => d.appendRecord(entry, record)
    .then(() => (d.removeMarker ? d.removeMarker().catch(() => undefined) : undefined))
    .then(() => d.readRuns()).then(d.setRuns)
    .catch((e: unknown) => { d.log(`run record not written: ${e instanceof Error ? e.message : String(e)}`); });
  const afterRecord = () => {
    // Not awaited and fail-open: a signal never delays or fails the run.
    if (d.postRunFinished) void d.postRunFinished(entry, record).then(() => d.onSignalPosted());
  };
  const manualShip = (item: WorkItem): ManualShip => ({ item, entry, diff: worktreeDiff, reviewedPatchId: diffSummary?.patchId ?? null, mergedMr: i.mergedMr });
  if (activeRun && end) {
    // Every loop but the Factory: saved state back, then the record, then the end rule (run-end.ts).
    const item: WorkItem = { source: "text", id: null, title: `${loop.name} run ${activeRun.runId}`, body: "", repo: null };
    const done = await endWorktreeRun({
      syncStateBack: d.syncStateBack,
      saveRecord: async () => { await saveRecord(); afterRecord(); },
      removeIfEmpty: () => d.host<boolean>("loop_worktree_remove_if_empty", { runId: activeRun.runId }),
      ship: () => d.ship({ runId: activeRun.runId, projectRoot: i.projectRoot, mode: "full", item: { ...item, key: `loop:${activeRun.runId}`, provider: null }, info: activeRun, entry, statusCode: "success", needsDecision: false, failedStage: null, kind: "passed", processName: loop.name, mergedMr: i.mergedMr, runPrefix: i.runPrefix }),
      log: d.log,
    }, end, { branch: activeRun.branch, passed: outcome.passed });
    if (done.line !== null) {
      d.setNotice(`The loop passed. ${done.line}`);
      void d.readRuns().then(d.setRuns).catch(() => undefined);
    }
    // Held for review, or the shipper was blocked (secret scan, CI/hook files, large diff, no repository set up): the Ship panel is the manual path.
    return { manualShip: done.panel ? manualShip(item) : null };
  }
  await saveRecord();
  afterRecord();
  // A Factory run started here offers Ship for its work item.
  if (activeRun && i.start && isFactory && outcome.passed && !outcome.cancelled && loop.config.openMergeRequest) return { manualShip: manualShip(i.start.item) };
  return { manualShip: null };
}
