// The Refactoring loop's several-batches-per-run driver: the shared step driver (step-driver.ts) with the refactor recipe.
// Batches depend on each other, so one blocked batch ends the run.
import type { LoopEngineConfig, LoopStage } from "./model.ts";
import type { LoopRunOutcome, RunnerDeps } from "./runner.ts";
import { nextTodo, runSteps, splitPhases, type StepDriverOpts, type StepRecipe } from "./step-driver.ts";

export type RefactorBatchOpts = StepDriverOpts;

export const REFACTOR_RECIPE: StepRecipe = {
  prefix: "R",
  planningKeys: new Set(["refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check"]),
  stepKeys: new Set(["refactor-test-write", "refactor-test-baseline", "refactor-apply", "refactor-conform", "refactor-test", "refactor-ledger", "refactor-graph-check"]),
  stepSkills: new Set(["skills/test-gap-writer", "skills/refactor-apply"]),
  applySkill: "skills/refactor-apply",
  baselineKeys: ["refactor-test-baseline", "refactor-test"],
  baselineStageKey: "refactor-test-baseline",
  limitOf: (c) => c.refactorBatchesPerRun,
  noun: "batch", nouns: "batches", doneWord: "applied", blockById: false, blockedStreak: 0,
  // A whole-repository plan holds one area at a time: when its batches are used up the planner opens the next area.
  replanWhenDone: true,
};

/** Splits the stages into the planning phase and the batch phase by defaultKey (see `splitPhases`). */
export const splitRefactorPhases = (stages: readonly LoopStage[]) => splitPhases(REFACTOR_RECIPE, stages);

/** The first `(status: todo)` batch in the plan, or null. */
export const nextTodoBatch = (plan: string | null) => nextTodo(REFACTOR_RECIPE, plan);

export const runRefactorBatches = (config: LoopEngineConfig, deps: RunnerDeps, opts: RefactorBatchOpts): Promise<LoopRunOutcome> => runSteps(REFACTOR_RECIPE, config, deps, opts);
