// Write guards for one agent call in the native Loop: the protected-path check, the halt an unsafe write raises, and the
// check that a report was really written. Shared by stage execution and the AI step review, so a review's writes meet
// the same rules as any other agent stage.
import type { AgentWrites } from "./agent-call.ts";
import type { LoopDefinition } from "./model.ts";
import type { StageRunResult } from "./runner.ts";
import { checkWrites } from "./protected.ts";
import type { HaltState, StageExecContext } from "./stage-exec.ts";
import { changedPathArgs } from "./worktree-run.ts";

/** The agent call's timeout plus this transport grace is what the core request may take (its default is 30 s). */
export const AGENT_TRANSPORT_GRACE_MS = 60_000;

/** Paths with uncommitted changes before an agent call. `null` = the snapshot failed, so nothing may be reverted. */
export async function dirtyBefore(ctx: StageExecContext): Promise<Set<string> | null> {
  try { return new Set(await ctx.host<string[]>("loop_changed_paths", changedPathArgs(ctx.runId, ctx.projectRoot))); } catch { return null; }
}

/** Paths git reports as changed right now; null when git cannot say (the post-throw check needs this). */
export async function changedPathsNow(ctx: StageExecContext): Promise<string[] | null> {
  try { return await ctx.host<string[]>("loop_changed_paths", changedPathArgs(ctx.runId, ctx.projectRoot)); } catch { return null; }
}

/**
 * Everything the run changed in total: uncommitted work plus what it committed since its base (Ship commits inside the
 * run worktree, and a send-back reuses it). For the "no code was changed" decision only; the revert snapshot and the
 * post-throw check keep the uncommitted-only `changedPathsNow`. Null when git cannot say or the base is unknown.
 */
export async function runChangesNow(ctx: StageExecContext): Promise<string[] | null> {
  try { return await ctx.host<string[]>("loop_changed_paths", { ...changedPathArgs(ctx.runId, ctx.projectRoot), sinceBase: true }); } catch { return null; }
}

/** Protected-path and scope guard for one agent call (the Mac's checkScope + policy). */
export function guardProtected(ctx: StageExecContext, paths: readonly string[], target: LoopDefinition, before: ReadonlySet<string> | null, created: readonly string[] = []): Promise<string | null> {
  return checkWrites(
    paths,
    { policy: target.config.protectedPathPolicy, extraProtectedGlobs: target.config.extraProtectedGlobs, scopeGlobs: target.scopeGlobs },
    before,
    created,
    async (p, c) => { await ctx.host("loop_revert_paths", { paths: p, created: c, ...changedPathArgs(ctx.runId, ctx.projectRoot) }); },
    (line) => ctx.log(line),
  );
}

export const normaliseRel = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** The report is written only when the agent run itself reports the path (a stale file must never decide a gate). */
export function wroteReport(r: AgentWrites, path: string): boolean {
  const want = normaliseRel(path);
  return [...(r.changedPaths ?? []), ...(r.createdPaths ?? [])].some((p) => normaliseRel(p) === want);
}

/** The reason the run must stop after one agent call, or null when its writes were acceptable. */
export function stopReason(g: { error: string | null; violation: string | null }): string | null {
  if (g.error !== null) return `the agent call failed (${g.error})${g.violation ? `; ${g.violation}` : ""}`;
  return g.violation;
}

/** A failed or violating agent call: halts the run unless the user already cancelled it. */
export function haltOn(ctx: StageExecContext, halt: HaltState, violation: string | null, stop: string | null): StageRunResult {
  const output = stop ?? "the agent call failed";
  if (violation === null && ctx.isCancelled()) return { ok: false, output };
  halt.isError = violation === null;
  halt.reason = `${output}; the run stopped`;
  return { ok: false, output };
}
