// What the Loop screen does with a loop's worktree once a run is over (see `runEndAction`). Pure over its deps so node
// tests can drive the exact order: the saved state goes back to the main tree FIRST, then the run is recorded, and only
// then may anything be removed or shipped. The screen passes the host calls and the Factory's shipper, never a second one.
import type { RunEnd } from "./worktree-run.ts";

export interface RunEndDeps {
  /** Copies the Loop's saved state from the worktree back to the main tree (host `loop_worktree_state_sync`, "out"). */
  syncStateBack(): Promise<void>;
  /** Writes the run record and index row. */
  saveRecord(): Promise<void>;
  /** Removes the worktree and branch only when the branch has no commit beyond its base; true when removed. */
  removeIfEmpty(): Promise<boolean>;
  /** The Factory's auto-ship path (`shipFinishedRun`): "Draft MR: <url>" or "MR not opened: <why>". */
  ship(): Promise<string>;
  log(line: string): void;
}

export interface RunEndResult { end: RunEnd; stateSaved: boolean; removed: boolean; line: string | null; panel: boolean }

/**
 * The end of a non-Factory loop run, in this order:
 * 1. the saved state is copied back (a failure is logged, and then nothing is removed: the worktree holds the only copy);
 * 2. the run record is written;
 * 3. a passed run with an empty branch removes it (the host refuses while the branch has commits); a passed run with
 *    changes opens the draft MR (or holds for a person in human review); a failed or cancelled run keeps everything.
 * `panel` is true when a person must take it from here (held, or the shipper was blocked); the branch is kept then.
 */
export async function endWorktreeRun(d: RunEndDeps, end: RunEnd, run: { branch: string; passed: boolean }): Promise<RunEndResult> {
  let stateSaved = true;
  try { await d.syncStateBack(); } catch (e) {
    stateSaved = false;
    d.log(`The Loop's saved state could not be copied back to your working tree (${e instanceof Error ? e.message : String(e)}). It stays in the run's worktree, which is kept.`);
  }
  await d.saveRecord();
  let removed = false;
  if (end === "discard") {
    if (!stateSaved) d.log(`No changes, but the worktree is kept because its saved state was not copied back. Branch ${run.branch} is kept.`);
    else {
      try {
        removed = await d.removeIfEmpty();
        d.log(removed ? `No changes: the worktree and branch ${run.branch} were removed.` : `No new changes. Branch ${run.branch} is kept: it has earlier commits and its draft MR.`);
      } catch (e) {
        d.log(`No changes, but the worktree could not be removed: ${e instanceof Error ? e.message : String(e)}. Branch ${run.branch} is kept.`);
      }
    }
    return { end, stateSaved, removed, line: null, panel: false };
  }
  if (end === "hold") {
    d.log(`Held for your review on branch ${run.branch}; no MR was opened.`);
    return { end, stateSaved, removed, line: null, panel: true };
  }
  if (end === "ship") {
    d.log("Opening the draft MR…");
    let line: string;
    try { line = await d.ship(); } catch (e) { line = `MR not opened: ${e instanceof Error ? e.message : String(e)}`; }
    if (line === "") line = "MR not opened: nothing was shipped.";
    const blocked = line.startsWith("MR not opened:");
    d.log(blocked ? `${line}. Branch ${run.branch} is kept.` : line);
    return { end, stateSaved, removed, line, panel: blocked };
  }
  if (!run.passed) d.log(`The run did not pass, so no MR was opened. Branch ${run.branch} is kept: open the run in History to review or discard it.`);
  return { end, stateSaved, removed, line: null, panel: false };
}

/** Start of a run: the Loop's saved state goes into the worktree before any stage. A failure refuses the run (the branch is kept). */
export async function copyStateIn(d: { syncStateIn(): Promise<void> }, branch: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try { await d.syncStateIn(); return { ok: true }; } catch (e) {
    return { ok: false, message: `The Loop's saved state could not be copied into the worktree: ${e instanceof Error ? e.message : String(e)}. The run did not start; branch ${branch} is kept.` };
  }
}

/** The `finally` of a run: when the run ended without copying the state back (it threw), copy it back now. Never throws. */
export async function copyStateBackIfMissed(d: { syncStateBack(): Promise<void> }, alreadySaved: boolean): Promise<boolean> {
  if (alreadySaved) return false;
  try { await d.syncStateBack(); return true; } catch { return false; }
}
