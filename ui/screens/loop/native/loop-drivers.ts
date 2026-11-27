// The driver choice for one loop run: which function walks the loop's steps. One copy, called by the Loop page and by
// the run manager, so a loop runs the same way wherever it is started. No React and no host imports: the host call, the
// file API and the loggers come in through `DriverInput`.
import type { FsApi } from "../../explorer/fs";
import { hasRealProgress, runAllPasses } from "./all-passes.ts";
import { configFor, isFactoryLoop } from "./factory.ts";
import { maxPassesOf, type LoopDefinition, type LoopEngineConfig } from "./model.ts";
import { TEST_PLAN_PATH } from "./protected.ts";
import { runRefactorBatches } from "./refactor-batches.ts";
import { runNativeLoop, type LoopRunOutcome, type RunnerDeps } from "./runner.ts";
import { decodeWorktreeDiff } from "./ship-model.ts";
import type { HostInvoke } from "./stage-exec.ts";
import { runTestSteps } from "./test-steps.ts";
import { repoPrefixFor, type RunInfo } from "./worktree-run.ts";

export type DriverKind = "refactor" | "test" | "allPasses" | "plain";

/** The step functions a run can use; tests (and the run manager's `runLoop` dep) replace any of them. */
export interface DriverFns {
  refactor: typeof runRefactorBatches;
  test: typeof runTestSteps;
  allPasses: typeof runAllPasses;
  plain: typeof runNativeLoop;
}

export const DEFAULT_DRIVERS: DriverFns = { refactor: runRefactorBatches, test: runTestSteps, allPasses: runAllPasses, plain: runNativeLoop };

/** A reused worktree carries the earlier run's code, which may be red on purpose (send-back, rework): a baseline check there would stop the run before Implement can fix it. */
export function withBaselineFor<T extends { baselineCheck?: unknown }>(deps: T, reusedWorktree: boolean): Omit<T, "baselineCheck"> | T {
  if (!reusedWorktree) return deps;
  const { baselineCheck: _skipped, ...rest } = deps;
  return rest;
}

/**
 * Refactoring and Test walk their plan step by step and need a worktree to roll a failed step back; "one item I name" is
 * the person's own task, so it runs as one plain pass; "Everything" repeats passes; anything else is one plain run.
 */
export function pickDriver(target: LoopDefinition, runConfig: LoopEngineConfig, hasWorktree: boolean, oneItem: boolean): DriverKind {
  if (target.defaultKey === "refactor" && hasWorktree) return "refactor";
  if (target.defaultKey === "test" && hasWorktree && !oneItem) return "test";
  if (hasWorktree && !isFactoryLoop(target) && !oneItem && target.defaultKey !== "refactor" && maxPassesOf(runConfig) > 1) return "allPasses";
  return "plain";
}

export interface DriverInput {
  target: LoopDefinition;
  runConfig: LoopEngineConfig;
  runDeps: RunnerDeps;
  activeRun: RunInfo | null;
  oneItem: boolean;
  projectRoot: string;
  fs: Pick<FsApi, "read" | "write">;
  host: HostInvoke;
  /** The step drivers' log (Refactoring and Test). */
  batchLog(line: string): void;
  /** The "Everything" driver's log. */
  passesLog(line: string): void;
}

/** The step driver's rollback and plan access for one worktree run (Refactoring: REFACTOR.md; the Test loop passes TEST_PLAN_PATH). */
function stepDriverOpts(i: DriverInput, run: RunInfo, planRel: string) {
  const prefix = repoPrefixFor(i.projectRoot, run.worktree);
  const planPath = prefix ? `${prefix}/${planRel}` : planRel;
  return {
    checkpoint: async () => i.host<string>("loop_worktree_checkpoint", { runId: run.runId }),
    restore: async (tree: string) => { await i.host("loop_worktree_restore", { runId: run.runId, tree }); },
    readPlan: async (): Promise<string | null> => {
      try {
        const r = await i.fs.read(planPath, 2_000_000);
        return r.status === "ok" ? (r.text ?? null) : null;
      } catch (e) {
        if (["not_found", "missing"].includes(String((e as { code?: unknown } | null)?.code ?? ""))) return null;
        throw e;
      }
    },
    writePlan: async (text: string) => { await i.fs.write(planPath, text, { expected_hash: null, force: true }); },
    log: i.batchLog,
  };
}

/** The Everything mode's checkpoint and progress check for one worktree run: progress = a changed path outside the loop's own folders. */
function allPassesOpts(i: DriverInput, run: RunInfo) {
  return {
    checkpoint: async () => i.host<string>("loop_worktree_checkpoint", { runId: run.runId }),
    progressed: async (before: string) => {
      const diff = decodeWorktreeDiff(await i.host<unknown>("loop_worktree_diff", { runId: run.runId, since: before }));
      if (!diff) throw new Error("the worktree diff could not be read");
      return hasRealProgress(diff.files);
    },
    log: i.passesLog,
  };
}

/** Runs the loop with the driver `pickDriver` chose. */
export async function runLoopWithDriver(i: DriverInput, fns: DriverFns = DEFAULT_DRIVERS): Promise<LoopRunOutcome> {
  const { target, runConfig, runDeps, activeRun, oneItem } = i;
  const kind = pickDriver(target, runConfig, activeRun !== null, oneItem);
  if (activeRun) {
    if (kind === "refactor") return fns.refactor(runConfig, runDeps, { ...stepDriverOpts(i, activeRun, "llm-doc/loop/refactor/REFACTOR.md"), ...(oneItem ? { maxBatches: 1 } : {}) });
    if (kind === "test") return fns.test(runConfig, runDeps, stepDriverOpts(i, activeRun, TEST_PLAN_PATH));
    if (kind === "allPasses") return fns.allPasses(runConfig, runDeps, allPassesOpts(i, activeRun));
  }
  return fns.plain(isFactoryLoop(target) ? configFor("full", runConfig) : runConfig, runDeps);
}
