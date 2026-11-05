// One in-flight Auto Task across the page runner, the custom modal and the shell scheduler. Without this, a cron
// custom task and a manual built-in run can drive two agents over the same worktree and one run's Review revert can
// undo the other's edits.
let held = false;

export function autoTaskBusy(): boolean { return held; }

/** Claim the single slot. Returns false when another run already holds it. */
export function tryAcquireAutoTask(): boolean {
  if (held) return false;
  held = true;
  return true;
}

export function releaseAutoTask(): void { held = false; }
