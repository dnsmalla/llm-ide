// The AI step review of one passed Loop step. The review agent sees only that step's diff (since the checkpoint taken
// before the step ran) and writes one verdict file under .factory/. Every failure here becomes a skipped review or a
// skipped baseline, never a throw, so a review problem cannot take the run down. Only a write outside .factory/ halts
// the run, as it does for any other agent stage.
import { runCommandLines } from "./run-command.ts";
import { agentRunSucceeded } from "../../autotasks/native/model.ts";
import { guardedAgentCall, type GuardedCallOutcome } from "./agent-call.ts";
import { agentRunBody, stepDiffSection } from "./factory.ts";
import { ensureDir } from "./codegraph.ts";
import type { LoopDefinition, LoopStage } from "./model.ts";
import { revertPlan } from "./protected.ts";
import { parseStepVerdict, STEP_REVIEW_SKILL, STEP_REVIEWS_FILE, stepReviewPath } from "./review.ts";
import type { StepReviewResult, StepSnapshot } from "./runner.ts";
import { AGENT_TRANSPORT_GRACE_MS, changedPathsNow, dirtyBefore, haltOn, stopReason, wroteReport } from "./stage-guard.ts";
import { type AgentRunReply, type HaltState, type StageExecContext } from "./stage-exec.ts";
import { changedPathArgs, repoPrefixFor } from "./worktree-run.ts";

/** One review pass reads one step's diff and writes a verdict: far shorter than a build stage. */
const STEP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;

const isFactoryPath = (p: string): boolean => p === ".factory" || p.startsWith(".factory/");
const skipped = (reason: string): StepReviewResult => ({ verdict: "skipped", findings: "", reason });
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A root-relative file's text, or null when it is missing, unreadable or not text. */
export async function readRunFile(ctx: StageExecContext, rel: string): Promise<string | null> {
  const prefix = repoPrefixFor(ctx.projectRoot, ctx.runRoot);
  try {
    const r = await ctx.fs.read(prefix ? `${prefix}/${rel}` : rel, 200_000);
    return r.status === "ok" && typeof r.text === "string" ? r.text : null;
  } catch {
    return null;
  }
}

/** Takes the baseline a step's review diffs against. Null (logged) when the run has no worktree or git cannot checkpoint. */
export async function takeStepSnapshot(ctx: StageExecContext): Promise<StepSnapshot | null> {
  if (ctx.runId === null) {
    ctx.log("step review skipped: this run has no worktree, so the step's diff cannot be isolated");
    return null;
  }
  try {
    const tree = await ctx.host<unknown>("loop_worktree_checkpoint", { runId: ctx.runId });
    if (typeof tree === "string" && tree !== "") return { tree };
    ctx.log("step review skipped: the checkpoint returned no tree");
    return null;
  } catch (e) {
    ctx.log(`step review skipped: no baseline could be taken (${messageOf(e)})`);
    return null;
  }
}

/** The step's diff since its checkpoint. A lost checkpoint falls back to the run's whole diff (logged), never a skip. */
async function stepDiff(ctx: StageExecContext, runId: string, snapshot: StepSnapshot): Promise<{ text: string; truncated: boolean; changedFiles: number | null }> {
  let d: { text?: unknown; truncated?: unknown; files?: unknown };
  try {
    d = await ctx.host<typeof d>("loop_worktree_diff", { runId, since: snapshot.tree });
  } catch (e) {
    ctx.log(`step review: baseline lost (${messageOf(e)}); reviewing the run's whole diff instead`);
    d = await ctx.host<typeof d>("loop_worktree_diff", { runId });
  }
  // The host already leaves .factory/ out of the diff, so an empty list means the step touched no reviewable file.
  return { text: typeof d.text === "string" ? d.text : "", truncated: d.truncated === true, changedFiles: Array.isArray(d.files) ? d.files.length : null };
}

/** The reviewer may write only its verdict file under .factory/: any other path is reverted and judged a violation. */
async function guardReviewWrites(ctx: StageExecContext, paths: readonly string[], before: ReadonlySet<string> | null, created: readonly string[]): Promise<string | null> {
  const outside = paths.filter((p) => !isFactoryPath(p));
  if (outside.length === 0) return null;
  const plan = revertPlan(outside, before, created);
  if (!plan.revert) return `the step reviewer wrote outside .factory/: ${outside.join(", ")} (${plan.reason})`;
  try {
    await ctx.host("loop_revert_paths", { paths: plan.paths, created: plan.created, ...changedPathArgs(ctx.runId, ctx.projectRoot) });
  } catch (e) {
    return `the step reviewer wrote outside .factory/ and the revert failed: ${outside.join(", ")} (${messageOf(e)})`;
  }
  return `the step reviewer wrote outside .factory/ and they were reverted: ${outside.join(", ")}`;
}

/** The review message: the step, the goal, where the verdict goes, and the step's diff as data. */
function reviewMessage(loop: LoopDefinition, stage: LoopStage, outputPath: string, command: string | undefined, diff: { text: string; truncated: boolean }): string {
  const parts = [`Step: ${stage.name}`];
  // No accepted lessons here on purpose: a lesson guides doing the step, and must never steer the judge of that step.
  if (loop.goal) parts.push(`Loop goal: ${loop.goal}`);
  if (loop.acceptanceCriteria) parts.push(`Acceptance criteria: ${loop.acceptanceCriteria}`);
  parts.push(...runCommandLines(command));
  parts.push(`Output path: ${outputPath}`, stepDiffSection(diff));
  return parts.join("\n\n");
}

/**
 * Reviews one passed step against its snapshot. Returns approve or changes from the verdict file, or skipped with a
 * reason. A write violation halts the run (through `halt`) and is reported as skipped.
 */
export async function reviewStepOnce(ctx: StageExecContext, loop: LoopDefinition, stage: LoopStage, snapshot: StepSnapshot, halt: HaltState): Promise<StepReviewResult> {
  const runId = ctx.runId;
  if (runId === null) return skipped("this run has no worktree, so the step's diff cannot be isolated");
  const outputPath = stepReviewPath(stage.id);
  // A verdict left by an earlier pass or run must never pass this one: the file is removed before the reviewer runs.
  try {
    await ctx.host("loop_clear_factory_output", { path: outputPath, runId });
  } catch (e) {
    return skipped(`the old review could not be cleared (${messageOf(e)})`);
  }
  let diff: { text: string; truncated: boolean; changedFiles: number | null };
  try {
    diff = await stepDiff(ctx, runId, snapshot);
  } catch (e) {
    return skipped(`the step's diff could not be read (${messageOf(e)})`);
  }
  // Without this the skill turns "no diff" into a [high] finding, which would pay for a review and then a repair loop over nothing.
  if (diff.changedFiles === 0 || diff.text.trim() === "") return skipped("the step changed no files");
  const message = reviewMessage(loop, stage, outputPath, ctx.runCommand, diff);
  const before = await dirtyBefore(ctx);
  const g: GuardedCallOutcome<AgentRunReply> = await guardedAgentCall<AgentRunReply>({
    before,
    call: () => ctx.core.request<AgentRunReply>("/kb/loop/agent-run", {
      method: "POST",
      body: agentRunBody({ message, stage: { kind: "skill", skillId: STEP_REVIEW_SKILL }, repoRoot: ctx.runRoot, timeoutMs: STEP_REVIEW_TIMEOUT_MS, projectRoot: ctx.projectRoot, llmDocExists: false }),
      timeoutMs: STEP_REVIEW_TIMEOUT_MS + AGENT_TRANSPORT_GRACE_MS,
      signal: ctx.signal,
    }),
    changedNow: () => changedPathsNow(ctx),
    check: (paths, b, created) => guardReviewWrites(ctx, paths, b, created),
  });
  if (g.violation !== null) {
    haltOn(ctx, halt, g.violation, stopReason(g));
    return skipped("the review halted the run");
  }
  if (g.result === null) return skipped(`the review agent call failed (${g.error})`);
  const r = g.result;
  const cost = typeof r.usage?.costUsd === "number" ? { usage: { costUsd: r.usage.costUsd } } : {};
  if (!agentRunSucceeded(r)) return { ...skipped(`the review agent run did not finish (${r.resultSubtype ?? "no result"})`), ...cost };
  if (!wroteReport(r, outputPath)) return { ...skipped(`the step reviewer wrote no verdict file (${outputPath} not reported)`), ...cost };
  const text = await readRunFile(ctx, outputPath);
  const verdict = parseStepVerdict(text);
  if (verdict === null || text === null) return { ...skipped(`the step reviewer wrote no verdict line in ${outputPath}`), ...cost };
  return verdict === "approve" ? { verdict, findings: "", ...cost } : { verdict, findings: text, ...cost };
}

/**
 * Appends a step whose review ended unresolved to .factory/STEP-REVIEWS.md, where the Factory Review reads it. Never
 * throws: a notes write that fails is logged, and the run carries on without the note.
 */
export async function noteUnresolvedStep(ctx: StageExecContext, stage: LoopStage, findings: string): Promise<void> {
  try {
    const previous = (await readRunFile(ctx, STEP_REVIEWS_FILE)) ?? "";
    const prefix = repoPrefixFor(ctx.projectRoot, ctx.runRoot);
    const rel = prefix ? `${prefix}/${STEP_REVIEWS_FILE}` : STEP_REVIEWS_FILE;
    const separator = previous === "" || previous.endsWith("\n\n") ? "" : previous.endsWith("\n") ? "\n" : "\n\n";
    await ensureDir(ctx.fs, rel);
    await ctx.fs.write(rel, `${previous}${separator}## ${stage.name}\n\n${findings.trim()}\n`, { expected_hash: null, force: true });
  } catch (e) {
    ctx.log(`step review notes not written: ${messageOf(e)}`);
  }
}
