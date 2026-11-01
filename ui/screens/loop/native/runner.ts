// Native Loop iteration/repair orchestrator, ported from LoopEngineRunner's outer loop: every iteration re-runs all
// enabled stages from the top; an advisory failure is recorded but does not gate; a blocking failure may be repaired
// up to maxRepairsPerStage; the run ends at a repair budget, the consecutive non-improving stop, or maxIterations.
import type { LoopEngineConfig, LoopStage } from "./model.ts";

export interface StageRunResult { ok: boolean; output: string }
export interface RunnerDeps {
  /** Execute one stage once. Throws for a kind this build cannot run. */
  runStage(stage: LoopStage): Promise<StageRunResult>;
  /** Ask the repair agent to fix a failed stage. `attempt` is 1-based for this stage/run. */
  repair(stage: LoopStage, output: string, attempt: number): Promise<StageRunResult>;
  log(line: string): void;
}
export interface StageOutcome { stage: LoopStage; ok: boolean; output: string }
export interface LoopRunOutcome {
  passed: boolean;
  iterationsUsed: number;
  stages: StageOutcome[];
  /** The blocking stage that ended the run, when it failed. */
  failedStage: LoopStage | null;
  statusSummary: string;
}

export async function runNativeLoop(config: LoopEngineConfig, deps: RunnerDeps): Promise<LoopRunOutcome> {
  const stages = config.stages.filter((s) => s.enabled);
  if (stages.length === 0) throw new Error("this loop has no enabled stages");
  const repairs = new Map<string, number>();
  let lastFailure = "";
  let nonImproving = 0;
  let iterationsUsed = 0;
  const outcomes: StageOutcome[] = [];

  for (let iteration = 1; iteration <= Math.max(1, config.maxIterations); iteration++) {
    iterationsUsed = iteration;
    deps.log(`— iteration ${iteration} of ${Math.max(1, config.maxIterations)} —`);
    let failed: StageOutcome | null = null;
    for (const stage of stages) {
      const result = await deps.runStage(stage);
      const outcome = { stage, ok: result.ok, output: result.output };
      outcomes.push(outcome);
      deps.log(`${result.ok ? "✓" : "✗"} ${stage.name}: ${result.ok ? "passed" : "failed"}`);
      if (!result.ok && stage.severity === "blocking") { failed = outcome; break; }
    }
    if (!failed) {
      return { passed: true, iterationsUsed, stages: outcomes, failedStage: null, statusSummary: `passed after ${iterationsUsed} iteration${iterationsUsed === 1 ? "" : "s"}` };
    }
    const used = repairs.get(failed.stage.id) ?? 0;
    if (!failed.stage.allowsRepair) {
      return { passed: false, iterationsUsed, stages: outcomes, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair is disabled for this stage` };
    }
    if (used >= Math.max(1, config.maxRepairsPerStage)) {
      return { passed: false, iterationsUsed, stages: outcomes, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair budget exhausted` };
    }
    deps.log(`↻ repairing ${failed.stage.name} (attempt ${used + 1} of ${Math.max(1, config.maxRepairsPerStage)})`);
    const repair = await deps.repair(failed.stage, failed.output, used + 1);
    repairs.set(failed.stage.id, used + 1);
    if (!repair.ok) {
      return { passed: false, iterationsUsed, stages: outcomes, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair did not complete` };
    }
    const signature = failed.output.trim().slice(0, 2000);
    if (signature === lastFailure) nonImproving += 1; else nonImproving = 1;
    lastFailure = signature;
    if (nonImproving >= Math.max(1, config.consecutiveFailureStop)) {
      return { passed: false, iterationsUsed, stages: outcomes, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed ${nonImproving} times without improvement` };
    }
  }
  const last = outcomes[outcomes.length - 1] ?? null;
  return { passed: false, iterationsUsed, stages: outcomes, failedStage: last?.stage ?? null, statusSummary: `max iterations (${iterationsUsed}) reached` };
}
