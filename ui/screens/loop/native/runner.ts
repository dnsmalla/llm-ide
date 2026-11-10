// Native Loop iteration/repair orchestrator, ported from LoopEngineRunner's outer loop: every iteration re-runs all
// enabled stages from the top, except a runOnce stage that already passed in this run; an advisory failure is recorded but does not gate; a blocking failure may be repaired
// up to maxRepairsPerStage; the run ends at a repair budget, the consecutive non-improving stop, or maxIterations.
import type { LoopEngineConfig, LoopStage } from "./model.ts";

export interface StageRunResult { ok: boolean; output: string; durationMs?: number; usage?: { costUsd?: number } }
export interface RunnerDeps {
  /** Execute one stage once. `prior` is every outcome so far (including earlier iterations). Throws for an unsupported kind. */
  runStage(stage: LoopStage, prior: readonly StageOutcome[]): Promise<StageRunResult>;
  /** Ask the repair agent to fix a failed stage. `attempt` is 1-based for this stage/run. */
  repair(stage: LoopStage, output: string, attempt: number): Promise<StageRunResult>;
  log(line: string): void;
  /** Asked between stages so Stop can end the run without starting the next stage. */
  isCancelled?(): boolean;
  /** A reason the run must end now, not cancelled: a violation that could not be reverted safely. Null = carry on. */
  halt?(): string | null;
  /** True when the current halt is an agent call that failed with nothing out of scope: the Mac's `.error`, not `blocked`. */
  haltIsError?(): boolean;
  /**
   * Holds at a stage boundary while the user has paused the run. Resolves "ok" when resumed (or cancelled, which the
   * next check reports) and "timedOut" when the pause outlasted `timeoutSeconds` (0 = no limit) without a resume.
   */
  holdWhilePaused?(timeoutSeconds: number): Promise<"ok" | "timedOut">;
}
export interface StageOutcome { stage: LoopStage; ok: boolean; output: string; durationMs?: number; usage?: { costUsd?: number } }
export interface LoopIterationOutcome { index: number; stages: StageOutcome[]; repair: { stageId: string; attempt: number; ok: boolean } | null }
export interface LoopRunOutcome {
  passed: boolean;
  iterationsUsed: number;
  stages: StageOutcome[];
  iterations: LoopIterationOutcome[];
  costUsd?: number;
  /** The blocking stage that ended the run, when it failed. */
  failedStage: LoopStage | null;
  statusSummary: string;
  cancelled?: boolean;
  /** Ended by a halt (a violation that could not be reverted safely): the Mac's `blocked` status, not a give-up. */
  blocked?: boolean;
  /** Ended by a halt for an agent call that failed (timeout, dropped connection) without a violation: the Mac's `error`. */
  errored?: boolean;
}

export async function runNativeLoop(config: LoopEngineConfig, deps: RunnerDeps): Promise<LoopRunOutcome> {
  const stages = config.stages.filter((s) => s.enabled);
  if (stages.length === 0) throw new Error("this loop has no enabled stages");
  const repairs = new Map<string, number>();
  let lastFailure = "";
  let nonImproving = 0;
  let iterationsUsed = 0;
  const outcomes: StageOutcome[] = [];
  const iterations: LoopIterationOutcome[] = [];
  // Ids of runOnce stages that passed in this run; later iterations skip them instead of paying for them again.
  const passedOnce = new Set<string>();
  const started = Date.now();
  const budgetMs = config.wallClockBudgetSeconds === null ? null : Math.max(0, config.wallClockBudgetSeconds) * 1000;
  // Paused time does not count toward the wall-clock budget (the Mac's pausedSeconds).
  let pausedMs = 0;
  const expired = () => budgetMs !== null && Date.now() - started - pausedMs >= budgetMs;
  let spentUsd = 0;
  const haltedOutcome = (): LoopRunOutcome | null => {
    const reason = deps.halt?.();
    if (!reason) return null;
    const errored = deps.haltIsError?.() === true;
    return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: reason, ...(errored ? { errored: true } : { blocked: true }) };
  };
  const heldOutcome = async (): Promise<LoopRunOutcome | null> => {
    if (!deps.holdWhilePaused) return null;
    const since = Date.now();
    const result = await deps.holdWhilePaused(config.pauseTimeoutSeconds);
    pausedMs += Date.now() - since;
    if (result !== "timedOut") return null;
    deps.log("pause timed out without a resume; the run is aborted to release the loop");
    return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "pause timed out without a resume; the run was aborted", cancelled: true };
  };

  for (let iteration = 1; iteration <= Math.max(1, config.maxIterations); iteration++) {
    const heldAtStart = await heldOutcome();
    if (heldAtStart) return heldAtStart;
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    if (expired()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "wall-clock budget reached" };
    const haltAtStart = haltedOutcome();
    if (haltAtStart) return haltAtStart;
    iterationsUsed = iteration;
    deps.log(`— iteration ${iteration} of ${Math.max(1, config.maxIterations)} —`);
    const iterationOutcomes: StageOutcome[] = [];
    let failed: StageOutcome | null = null;
    for (const stage of stages) {
      if (stage.runOnce && passedOnce.has(stage.id)) {
        deps.log(`↷ ${stage.name}: passed earlier in this run`);
        continue;
      }
      const heldAtStage = await heldOutcome();
      if (heldAtStage) return heldAtStage;
      if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
      if (expired()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "wall-clock budget reached" };
      const haltAtStage = haltedOutcome();
      if (haltAtStage) return haltAtStage;
      const result = await deps.runStage(stage, outcomes);
      const outcome = { stage, ok: result.ok, output: result.output, durationMs: result.durationMs, usage: result.usage };
      spentUsd += result.usage?.costUsd ?? 0;
      outcomes.push(outcome);
      iterationOutcomes.push(outcome);
      deps.log(`${result.ok ? "✓" : "✗"} ${stage.name}: ${result.ok ? "passed" : "failed"}`);
      if (result.ok && stage.runOnce) passedOnce.add(stage.id);
      if (config.maxCostUsd !== null && spentUsd >= config.maxCostUsd) {
        return { passed: false, iterationsUsed, stages: outcomes, iterations, failedStage: stage, statusSummary: `cost ceiling reached ($${spentUsd.toFixed(2)} of $${config.maxCostUsd})`, costUsd: spentUsd };
      }
      if (!result.ok && stage.severity === "blocking") { failed = outcome; break; }
      const haltAfterStage = haltedOutcome();
      if (haltAfterStage) return haltAfterStage;
    }
    if (!failed) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      return { passed: true, iterationsUsed, stages: outcomes, iterations, failedStage: null, costUsd: spentUsd, statusSummary: `passed after ${iterationsUsed} iteration${iterationsUsed === 1 ? "" : "s"}` };
    }
    // A halt raised by the blocking stage itself (its agent call wrote something it must not) ends the run before any repair.
    const haltAfterFailure = haltedOutcome();
    if (haltAfterFailure) { iterations.push({ index: iteration, stages: iterationOutcomes, repair: null }); return haltAfterFailure; }
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    const used = repairs.get(failed.stage.id) ?? 0;
    if (!failed.stage.allowsRepair) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair is disabled for this stage` };
    }
    if (used >= Math.max(1, config.maxRepairsPerStage)) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair budget exhausted` };
    }
    // Pause holds before a repair attempt too, as it does between stages; Stop while paused ends the run here.
    const heldBeforeRepair = await heldOutcome();
    if (heldBeforeRepair) return heldBeforeRepair;
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    deps.log(`↻ repairing ${failed.stage.name} (attempt ${used + 1} of ${Math.max(1, config.maxRepairsPerStage)})`);
    const repair = await deps.repair(failed.stage, failed.output, used + 1);
    spentUsd += repair.usage?.costUsd ?? 0;
    if (config.maxCostUsd !== null && spentUsd >= config.maxCostUsd) {
      return { passed: false, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `cost ceiling reached ($${spentUsd.toFixed(2)} of $${config.maxCostUsd})`, costUsd: spentUsd };
    }
    repairs.set(failed.stage.id, used + 1);
    iterations.push({ index: iteration, stages: iterationOutcomes, repair: { stageId: failed.stage.id, attempt: used + 1, ok: repair.ok } });
    const haltAfterRepair = haltedOutcome();
    if (haltAfterRepair) return haltAfterRepair;
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    if (!repair.ok) {
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair did not complete` };
    }
    const signature = failed.output.trim().slice(0, 2000);
    if (signature === lastFailure) nonImproving += 1; else nonImproving = 1;
    lastFailure = signature;
    if (nonImproving >= Math.max(1, config.consecutiveFailureStop)) {
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed ${nonImproving} times without improvement` };
    }
  }
  const last = outcomes[outcomes.length - 1] ?? null;
  return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: last?.stage ?? null, statusSummary: `max iterations (${iterationsUsed}) reached` };
}

/**
 * The run record's `statusCode`, as the Mac writes it: a halt that blocked the run is `blocked.repair_out_of_scope`; a Stop
 * or a pause that timed out is `aborted` (the Mac's `LoopEngineStatus.aborted`); an agent call that failed with nothing out
 * of scope is `error`; otherwise `success` or `failed`.
 */
export function runStatusCode(o: Pick<LoopRunOutcome, "passed" | "cancelled" | "blocked" | "errored">): string {
  if (o.blocked) return "blocked.repair_out_of_scope";
  if (o.errored) return "error";
  if (o.cancelled) return "aborted";
  return o.passed ? "success" : "failed";
}
