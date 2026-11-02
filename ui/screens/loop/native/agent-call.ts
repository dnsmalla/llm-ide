// One agent call whose writes are checked whether it returns or THROWS (a timeout, a dropped connection). The Mac
// re-checks after a throw (`withScopeGuard`): an agent can write files and then fail, and those writes must go through
// the same policy as a normal return. Shared by the Loop (skill and repair stages) and Auto Tasks (read-only revert).
import { wasDirtyBefore } from "./protected.ts";

export interface AgentWrites { changedPaths?: string[]; createdPaths?: string[] }

/** The policy for a set of written paths: a message when they violate it (after acting on them), else null. */
export type WriteCheck = (paths: readonly string[], before: ReadonlySet<string> | null, created: readonly string[]) => Promise<string | null>;

export interface GuardedCallDeps<R extends AgentWrites> {
  /** Paths with uncommitted changes before the call. Null = the snapshot failed, so nothing may be reverted. */
  before: ReadonlySet<string> | null;
  call(): Promise<R>;
  /** git's changed paths right now. Null (or a throw) = git cannot say. */
  changedNow(): Promise<string[] | null>;
  check: WriteCheck;
}

export interface GuardedCallOutcome<R> {
  /** The agent's answer, or null when the call threw. */
  result: R | null;
  /** The thrown error's message, or null when the call returned. */
  error: string | null;
  /** The paths the policy judged. */
  writes: string[];
  /** The policy's message when the writes violated it, or when git could not say what was written after a throw. */
  violation: string | null;
}

export async function guardedAgentCall<R extends AgentWrites>(deps: GuardedCallDeps<R>): Promise<GuardedCallOutcome<R>> {
  let result: R;
  try {
    result = await deps.call();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    let now: string[] | null;
    try { now = await deps.changedNow(); } catch { now = null; }
    if (now === null) {
      return { result: null, error, writes: [], violation: "the changes could not be read after the call failed, so they were left in place" };
    }
    // As on the Mac (`RepairScopeGuard.check(since:)`), only paths that became dirty during the call are the agent's:
    // a path already dirty before it is the user's and is never attributed (or reverted). With no snapshot, every
    // changed path is judged, and the check refuses to revert any of them.
    // shortcut: the Mac also content-hashes already-dirty protected paths to catch an agent re-editing one; that needs
    // a host hash command, so such an edit after a throw goes unseen here (it is never reverted either way).
    const before = deps.before;
    const writes = before === null ? now : now.filter((p) => !wasDirtyBefore(p, before));
    // Nothing is known about which file the agent wrote, so no file is "created" by it: an untracked file is kept.
    return { result: null, error, writes, violation: await deps.check(writes, deps.before, []) };
  }
  const writes = result.changedPaths ?? [];
  return { result, error: null, writes, violation: await deps.check(writes, deps.before, result.createdPaths ?? []) };
}
