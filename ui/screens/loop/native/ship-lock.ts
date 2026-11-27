// One in-flight guard for every way a run's branch is shipped (the run-end ship, Factory auto-ship, a board Approve and
// the Ship panel), so the same branch is never pushed twice at once.
const inFlight = new Set<string>();

/** Runs `ship` for the worktree `runId`, or returns `busy()` without running it when a ship of that branch is already running. */
export async function withShipLock<T>(runId: string, busy: () => T, ship: () => Promise<T>): Promise<T> {
  if (inFlight.has(runId)) return busy();
  inFlight.add(runId);
  try {
    return await ship();
  } finally {
    inFlight.delete(runId);
  }
}
