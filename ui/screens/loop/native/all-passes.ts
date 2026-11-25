// The "Everything" work mode: one run repeats the loop's stages as passes until a pass changes nothing real. Each pass
// is a plain runNativeLoop with only what is left of the run's wall-clock budget and cost ceiling. A pass that did not
// pass, was stopped, held for review or blocked ends the run at once; earlier passes' stages stay in the record.
import { maxPassesOf, type LoopEngineConfig } from "./model.ts";
import { pauseBetween, runBudget, runNativeLoop, type LoopRunOutcome, type RunnerDeps, type StepReviewOutcome } from "./runner.ts";

export interface AllPassesOpts {
  /** A tree id of the worktree's current state (no commit). */
  checkpoint(): Promise<string>;
  /** True when the worktree holds real changes since `before` (see `hasRealProgress`). */
  progressed(before: string): Promise<boolean>;
  log(line: string): void;
}

// The loop's own bookkeeping: its ledgers and maps change on every pass and are not work.
const BOOKKEEPING = ["system/loop", "system/loop-runs", "system/loop-worktrees", "llm-doc/loop/", ".factory/"];

/** True when at least one path lies outside the loop's bookkeeping folders. */
export function hasRealProgress(paths: readonly string[]): boolean {
  return paths.some((p) => {
    const rel = p.replace(/^\.\//, "");
    return !BOOKKEEPING.some((b) => rel === b.replace(/\/$/, "") || rel.startsWith(b.endsWith("/") ? b : `${b}/`));
  });
}

export async function runAllPasses(config: LoopEngineConfig, deps: RunnerDeps, opts: AllPassesOpts): Promise<LoopRunOutcome> {
  const max = maxPassesOf(config);
  const { remaining, exhausted } = runBudget(config);
  let total: LoopRunOutcome | null = null;
  let passesRun = 0;
  for (let pass = 1; pass <= max; pass++) {
    const left = remaining(total?.costUsd ?? 0);
    const out = exhausted(left);
    if (total && out) return { ...total, statusSummary: `${total.statusSummary} (${pass - 1} passes; ${out})` };
    if (pass > 1) { opts.log(`Pass ${pass} of up to ${max}`); await pauseBetween(deps, config.stageDelaySeconds); }
    let before: string | null = null;
    try { before = await opts.checkpoint(); } catch (e) { opts.log(`No more passes: ${e instanceof Error ? e.message : String(e)}`); if (total) return total; }
    const r = await runNativeLoop({ ...config, ...left }, deps);
    passesRun = pass;
    const stepReviews: StepReviewOutcome[] = [...(total?.stepReviews ?? []), ...(r.stepReviews ?? [])];
    total = total === null ? r : {
      ...r,
      stages: [...total.stages, ...r.stages],
      iterations: [...total.iterations, ...r.iterations].map((it, i) => ({ ...it, index: i + 1 })),
      iterationsUsed: total.iterationsUsed + r.iterationsUsed,
      costUsd: (total.costUsd ?? 0) + (r.costUsd ?? 0),
      ...(stepReviews.length > 0 ? { stepReviews } : {}),
    };
    if (!r.passed || r.cancelled || r.awaitingReview || r.blocked || r.errored || before === null || pass === max) break;
    let moved = false;
    try { moved = await opts.progressed(before); } catch (e) { opts.log(`No more passes: ${e instanceof Error ? e.message : String(e)}`); }
    if (!moved) break;
  }
  const t = total!;
  const passes = passesRun;
  return t.passed && passes > 1 ? { ...t, statusSummary: `${t.statusSummary} (${passes} passes)` } : t;
}
