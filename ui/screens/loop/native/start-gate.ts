// One Loop start at a time. A start awaits the approval dialog and worktree setup before the run is marked running,
// so a second start in that window (two scheduled loops, a double click) would otherwise begin a second run in the
// same working tree. The gate is taken synchronously, before the first await, and held until the run has ended.

export interface StartGate {
  /** Takes the gate; false when a start or run already holds it. */
  tryAcquire(): boolean;
  release(): void;
  readonly held: boolean;
}

export function createStartGate(): StartGate {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() { held = false; },
    get held() { return held; },
  };
}
