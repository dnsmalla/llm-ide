// The one rule for loops that only CHECK: they never open a merge request, whatever their saved setting says.
// Regression re-checks faults and Plan writes planning documents; neither produces code to review, so their
// finished runs are cleaned up with Done instead of waiting for a merge. They run in the project folder, never in a
// worktree (loopRunsInWorktree), so Plan's output lands in llm-doc/loop/plan directly and Done only clears the card.
import type { LoopDefinition } from "./model.ts";

const CHECK_ONLY_KEYS: ReadonlySet<string> = new Set(["regression", "plan"]);

/** True for the Regression and Plan loops (by their built-in key). */
export function isCheckOnlyLoop(loop: Pick<LoopDefinition, "defaultKey">): boolean {
  return loop.defaultKey !== null && CHECK_ONLY_KEYS.has(loop.defaultKey);
}

/** Whether a passed run of this loop may open a merge request: its setting, and never for a check-only loop. */
export function opensMergeRequest(loop: Pick<LoopDefinition, "defaultKey" | "config">): boolean {
  return !isCheckOnlyLoop(loop) && loop.config.openMergeRequest;
}

/** Shown next to the disabled "open a merge request" setting. */
export const CHECK_ONLY_REASON = "This loop only checks: it never opens a merge request. Finished runs are closed with Done on its board.";
