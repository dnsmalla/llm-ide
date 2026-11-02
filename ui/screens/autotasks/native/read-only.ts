// The read-only revert for Auto Tasks: a read-only task may change files only to report, so its edits are reverted.
// Uses the Loop's revert rule (protected.ts `revertPlan`): nothing is reverted when a path had uncommitted changes
// before the run, so the user's own edits are never discarded.
import { revertPlan } from "../../loop/native/protected.ts";
import type { WriteCheck } from "../../loop/native/agent-call.ts";

/** The write check for a read-only task. `revert` is the host call (`loop_revert_paths`). */
export function readOnlyCheck(revert: (paths: string[], created: string[]) => Promise<void>): WriteCheck {
  return async (paths, before, created) => {
    if (paths.length === 0) return null;
    const plan = revertPlan(paths, before, created);
    if (!plan.revert) return `the read-only revert did not run: ${plan.reason}`;
    try {
      await revert(plan.paths, plan.created);
      return null;
    } catch (e) {
      return `the read-only revert failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
}
