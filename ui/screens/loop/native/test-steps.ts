// The Test loop's one-step-at-a-time driver: the shared step driver with the test recipe. The plan (TEST-PLAN.md) is
// written by the Test Map stage; Test Write does one `### T<n>` step per run of the step stages. Test steps are
// independent, so a blocked step is rolled back and the run goes on with the next one (3 blocked in a row stop it).
import type { LoopEngineConfig } from "./model.ts";
import { stepLimitOf } from "./model.ts";
import type { LoopRunOutcome, RunnerDeps } from "./runner.ts";
import { testSuiteExists } from "./test-plan.ts";
import { runSteps, type StepDriverOpts, type StepRecipe } from "./step-driver.ts";

export const TEST_RECIPE: StepRecipe = {
  prefix: "T",
  // Test Map writes the plan, so it plans; Test Map Check re-reads the code after each step and re-merges the plan.
  planningKeys: new Set(["test-structure", "test-setup", "test-structure-check", "test-map"]),
  stepKeys: new Set(["test-write", "test", "test-ledger", "test-map-check", "test-prune"]),
  stepSkills: new Set(["skills/test-gap-writer"]),
  applySkill: "skills/test-gap-writer",
  // The suite is checked once after planning (which may first create the test layout): if it was already red, a step
  // failing at Test is left todo and ends the run rather than being blocked.
  baselineKeys: ["test"],
  baselineStageKey: null,
  baselineAfterPlanning: true,
  skipChecksWhenSkipped: true,
  noRepair: true,
  // One fix round: the writer cannot run tests, so the failing run is the first time it sees them execute.
  stepRounds: 2,
  // A red suite with test files already in the repository stops the run; with none, the first step may be the one that fixes it.
  suiteExists: testSuiteExists,
  // The Test loop's "Steps per run" is the existing per-run limit (maxPassesPerRun, default 3), which it no longer uses for passes.
  limitOf: (c) => stepLimitOf(c),
  noun: "step", nouns: "steps", doneWord: "done", blockById: true, blockedStreak: 3,
};

export const runTestSteps = (config: LoopEngineConfig, deps: RunnerDeps, opts: StepDriverOpts): Promise<LoopRunOutcome> => runSteps(TEST_RECIPE, config, deps, opts);
