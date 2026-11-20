// Native Loop iteration/repair orchestrator, ported from LoopEngineRunner's outer loop: every iteration re-runs all
// enabled stages from the top, except a runOnce stage that already passed in this run; an advisory failure is recorded but does not gate; a blocking failure may be repaired
// up to maxRepairsPerStage; the run ends at a repair budget, the consecutive non-improving stop, or maxIterations.
// A stage that runs once per run (runsOncePerRun) is skipped in later iterations once it has passed.
import { clampIterations, type LoopEngineConfig, type LoopStage } from "./model.ts";
import { effectiveReviewAfter } from "./review.ts";
import { LOOPBACK_IDENTICAL_STOP, LOOPBACK_MAX_ROUNDS, LOOPBACK_STOPPED_CODE, failureSignature, findingsText, headAndTail, groupOfCode, groupOfVerify, loopbackGroups, stoppedSummary, type FindingsEntry, type LoopbackContext, type LoopbackGroup, type LoopbackSummary } from "./loopback.ts";

export interface StageRunResult { ok: boolean; output: string; durationMs?: number; usage?: { costUsd?: number } }

/** What the working tree looked like before a reviewed step ran; the review diffs against it. */
export interface StepSnapshot { tree: string }
export interface StepReviewResult { verdict: "approve" | "changes" | "skipped"; findings: string; reason?: string; usage?: { costUsd?: number } }
/** One review episode for a step: it ends approved, unresolved (budget spent, or findings stopped changing), or skipped. */
export interface StepReviewOutcome { stageId: string; stageName: string; verdict: "approve" | "unresolved" | "skipped"; attempts: number; findings: string; reason?: string }

/** A stage that runs once per run, not once per iteration: a passed one is skipped, so a repair never re-plans or re-applies.
 *  The refactor Test Baseline is one too: a loopback round would otherwise re-run it on the batch's broken tree. */
export function runsOncePerRun(stage: LoopStage): boolean {
  return stage.runOnce || stage.defaultKey === "refactor-test-baseline" || (stage.kind === "codeGraph" && stage.graphOp === "snapshot") || (stage.kind === "skill" && ["skills/refactor-planner", "skills/test-gap-writer", "skills/refactor-apply", "skills/refactor-conform"].includes(stage.skillId ?? ""));
}
export type ProgressEvent =
  | { type: "iteration"; iteration: number }
  | { type: "stage-start"; stage: LoopStage; index: number; count: number; iteration: number }
  | { type: "stage-result"; stage: LoopStage; ok: boolean; iteration: number; durationMs: number; costUsd?: number }
  | { type: "stage-skipped"; stage: LoopStage; index: number; count: number; iteration: number }
  | { type: "repair"; stage: LoopStage; attempt: number }
  | { type: "step-review"; stage: LoopStage; phase: "reviewing" | "fixing"; attempt: number }
  | { type: "step-review-result"; stage: LoopStage; verdict: StepReviewOutcome["verdict"]; attempts: number }
  | { type: "loopback"; stage: LoopStage; round: number; maxRounds: number; reason: "tests" | "review" }
  | { type: "paused"; paused: boolean };
export interface RunnerDeps {
  /** Execute one stage once. `prior` is every outcome so far (including earlier iterations). Throws for an unsupported kind. */
  runStage(stage: LoopStage, prior: readonly StageOutcome[], loopback?: LoopbackContext): Promise<StageRunResult>;
  /** Persist one round's findings (the plan notes file) so a re-run code stage and the final record keep every round. */
  recordFindings?(stage: LoopStage, entry: FindingsEntry): Promise<void>;
  /**
   * Ask the repair agent to fix a failed stage. `attempt` is 1-based for this stage/run. `opts.review` marks a repair
   * of AI step-review findings rather than of a failed stage, so the agent is told the step passed and what to fix.
   */
  repair(stage: LoopStage, output: string, attempt: number, opts?: { review?: boolean }): Promise<StageRunResult>;
  /**
   * Captures the tree before a reviewed stage runs. Null = no baseline is possible, so the step's diff cannot be
   * isolated and its review is skipped (recorded, not a failure).
   */
  snapshotBefore?(stage: LoopStage): Promise<StepSnapshot | null>;
  /** Reviews only the diff since `snapshot`. `attempt` is the 1-based review pass within this step's episode. */
  reviewStep?(stage: LoopStage, snapshot: StepSnapshot, attempt: number): Promise<StepReviewResult>;
  /** Records a step whose review ended unresolved, so the Review stage and the person see the open findings. */
  noteUnresolvedReview?(stage: LoopStage, findings: string): Promise<void>;
  log(line: string): void;
  /** Asked between stages so Stop can end the run without starting the next stage. */
  isCancelled?(): boolean;
  /** A reason the run must end now, not cancelled: a violation that could not be reverted safely. Null = carry on. */
  halt?(): string | null;
  /** True when the current halt is an agent call that failed with nothing out of scope: the Mac's `.error`, not `blocked`. */
  haltIsError?(): boolean;
  /**
   * Holds at a stage boundary while the user has paused the run. Resolves "ok" when resumed (or cancelled, which the
   * next check reports) and "timedOut" when the pause outlasted `timeoutSeconds` (0 = no limit) without a resume.
   */
  holdWhilePaused?(timeoutSeconds: number): Promise<"ok" | "timedOut">;
  /** Typed run progress for the board; never parsed out of the log. */
  onProgress?(event: ProgressEvent): void;
  /** Waits `ms` (the stage pause). Default: a 100 ms-tick wait that ends early once `isCancelled` is true. */
  sleep?(ms: number): Promise<void>;
}

/** Waits `ms` in 100 ms ticks, returning early once `isCancelled` is true so Stop is not held up by a pause. */
export async function waitUnlessCancelled(ms: number, isCancelled?: () => boolean, halted?: () => string | null | undefined): Promise<void> {
  for (let left = ms; left > 0 && !isCancelled?.() && !halted?.(); left -= 100) await new Promise((r) => setTimeout(r, Math.min(100, left)));
}

/** The pause before the next stage or batch: none at 0, and none once the run is cancelled or halted. */
export async function pauseBetween(deps: RunnerDeps, seconds: number): Promise<void> {
  if (seconds <= 0 || deps.isCancelled?.() || deps.halt?.()) return;
  await (deps.sleep ? deps.sleep(seconds * 1000) : waitUnlessCancelled(seconds * 1000, deps.isCancelled, deps.halt));
}
export interface StageOutcome { stage: LoopStage; ok: boolean; output: string; durationMs?: number; usage?: { costUsd?: number } }
export interface LoopIterationOutcome { index: number; stages: StageOutcome[]; repair: { stageId: string; attempt: number; ok: boolean } | null }
export interface LoopRunOutcome {
  passed: boolean;
  iterationsUsed: number;
  stages: StageOutcome[];
  iterations: LoopIterationOutcome[];
  costUsd?: number;
  /** The blocking stage that ended the run, when it failed. */
  failedStage: LoopStage | null;
  statusSummary: string;
  cancelled?: boolean;
  /** Ended by a halt (a violation that could not be reverted safely): the Mac's `blocked` status, not a give-up. */
  blocked?: boolean;
  /** Ended by a halt for an agent call that failed (timeout, dropped connection) without a violation: the Mac's `error`. */
  errored?: boolean;
  /** One entry per step review episode; set only when a step was reviewed or skipped. */
  stepReviews?: StepReviewOutcome[];
  /** Set when the run is held for a person's review. */
  awaitingReview?: boolean;
  /** Ended because the loopback rounds or a budget ran out without passing: the warning state, never shipped. */
  stoppedAtLimit?: boolean;
  /** Set only on a stopped run: it used up its loopback rounds, or a budget ended a run that has a Verify loopback. */
  loopback?: LoopbackSummary;
}

/** Step-review state that outlives one iteration, so a closed step is not reviewed again later in the run. */
interface StepReviewState {
  outcomes: StepReviewOutcome[];
  /** Stage ids whose review ended without approval; a later iteration runs them without reviewing again. */
  closed: Set<string>;
  /** Review-driven repairs made per stage in this run; separate from the stage's own repair budget. */
  repairs: Map<string, number>;
  /** Every loopback round's findings; the wrapper reads them to describe a run that a budget ended mid-loop. */
  findings: FindingsEntry[];
  /** True when the loop has at least one code stage paired with a Verify, so a budget stop is a loopback stop. */
  hasGroups: boolean;
}

export async function runNativeLoop(config: LoopEngineConfig, deps: RunnerDeps): Promise<LoopRunOutcome> {
  const reviews: StepReviewState = { outcomes: [], closed: new Set(), repairs: new Map(), findings: [], hasGroups: false };
  let outcome = await runLoopInner(config, deps, reviews);
  // A budget that ends a looping run (cost, wall clock) is the same warning state as running out of rounds, so it never ships.
  if (!outcome.passed && !outcome.cancelled && !outcome.blocked && !outcome.errored && !outcome.stoppedAtLimit && reviews.hasGroups && /^(cost ceiling reached|wall-clock budget reached)/.test(outcome.statusSummary)) {
    outcome = { ...outcome, stoppedAtLimit: true, loopback: { rounds: outcome.iterationsUsed, maxRounds: Math.min(clampIterations(config.maxIterations), LOOPBACK_MAX_ROUNDS), reason: "limit", findings: findingsText(reviews.findings), stopped: true } };
  }
  if (reviews.outcomes.length === 0) return outcome;
  // A spent review budget never stops the run: the findings carry forward to the final review and the MR, which
  // are the human hand-off. Only the cost ceiling ends a run from inside a review.
  // A loopback stop already names why it stopped, so the "unresolved" suffix would only repeat it.
  const note = outcome.loopback?.stopped && outcome.loopback.reason !== "limit" ? "" : stepReviewNote(reviews.outcomes);
  return { ...outcome, stepReviews: reviews.outcomes, statusSummary: `${outcome.statusSummary}${note}` };
}

/** The summary suffix naming step reviews a person still has to look at; empty when every review approved. */
export function stepReviewNote(outcomes: readonly Pick<StepReviewOutcome, "verdict">[]): string {
  const unresolved = outcomes.filter((r) => r.verdict === "unresolved").length;
  const skipped = outcomes.filter((r) => r.verdict === "skipped").length;
  return unresolved + skipped > 0 ? ` · step reviews: ${unresolved} unresolved, ${skipped} skipped` : "";
}

async function runLoopInner(config: LoopEngineConfig, deps: RunnerDeps, reviews: StepReviewState): Promise<LoopRunOutcome> {
  const stages = config.stages.filter((s) => s.enabled);
  if (stages.length === 0) throw new Error("this loop has no enabled stages");
  // Every code-writing loop gets the same cap; a lower configured value still wins.
  const maxRounds = Math.min(clampIterations(config.maxIterations), LOOPBACK_MAX_ROUNDS);
  const groups = loopbackGroups(stages);
  reviews.hasGroups = groups.length > 0;
  // Loopback state is separate from the legacy repair counters: a loopback round never spends a repair.
  let loopSignature: string | null = null;
  let unchanged = 0;
  // Every round's findings (the record and the stop summary) and each group's own (what its code stage is told), so a
  // later group's code stage never reads an earlier group's failures.
  const findings = reviews.findings;
  const groupFindings = new Map<string, FindingsEntry[]>();
  // One baseline per group across all rounds, so the review judges the whole step, not just the last round's fix.
  const groupBaseline = new Map<string, StepSnapshot | null>();
  const groupAttempts = new Map<string, number>();
  const reviewDue = new Set<string>();
  const repairs = new Map<string, number>();
  let lastFailure = "";
  let nonImproving = 0;
  let iterationsUsed = 0;
  const outcomes: StageOutcome[] = [];
  const iterations: LoopIterationOutcome[] = [];
  // Ids of runOnce stages that passed in this run; later iterations skip them instead of paying for them again.
  const passedOnce = new Set<string>();
  // Set once a stage has run: the next stage that starts waits config.stageDelaySeconds first (not before the first one).
  let stageRan = false;
  const started = Date.now();
  const budgetMs = config.wallClockBudgetSeconds === null ? null : Math.max(0, config.wallClockBudgetSeconds) * 1000;
  // Paused time does not count toward the wall-clock budget (the Mac's pausedSeconds).
  let pausedMs = 0;
  const expired = () => budgetMs !== null && Date.now() - started - pausedMs >= budgetMs;
  let spentUsd = 0;
  const haltedOutcome = (): LoopRunOutcome | null => {
    const reason = deps.halt?.();
    if (!reason) return null;
    const errored = deps.haltIsError?.() === true;
    return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: reason, ...(errored ? { errored: true } : { blocked: true }) };
  };
  const heldOutcome = async (): Promise<LoopRunOutcome | null> => {
    if (!deps.holdWhilePaused) return null;
    const since = Date.now();
    const result = await deps.holdWhilePaused(config.pauseTimeoutSeconds);
    pausedMs += Date.now() - since;
    if (result !== "timedOut") return null;
    deps.log("pause timed out without a resume; the run is aborted to release the loop");
    return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "pause timed out without a resume; the run was aborted", cancelled: true };
  };
  const ceilingOutcome = (stage: LoopStage): LoopRunOutcome | null => {
    if (config.maxCostUsd === null || spentUsd < config.maxCostUsd) return null;
    return { passed: false, iterationsUsed, stages: outcomes, iterations, failedStage: stage, statusSummary: `cost ceiling reached ($${spentUsd.toFixed(2)} of $${config.maxCostUsd})`, costUsd: spentUsd };
  };
  const cancelledOutcome = (): LoopRunOutcome => ({ passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true });
  // Records how one review episode ended. Anything but approval closes the step for the rest of the run.
  const endStepReview = async (stage: LoopStage, verdict: StepReviewOutcome["verdict"], attempts: number, findings: string, reason?: string): Promise<null> => {
    reviews.outcomes.push({ stageId: stage.id, stageName: stage.name, verdict, attempts, findings, ...(reason === undefined ? {} : { reason }) });
    if (verdict !== "approve") reviews.closed.add(stage.id);
    deps.onProgress?.({ type: "step-review-result", stage, verdict, attempts });
    if (verdict === "unresolved") await deps.noteUnresolvedReview?.(stage, findings);
    return null;
  };
  /**
   * One review pass: runs the reviewer, books its spend, and applies the ceiling / halt / Stop / wall-clock checks. The
   * progress card sits on `lane` (the Verify stage in a loopback group, so the card stays in that lane).
   */
  const reviewOnce = async (stage: LoopStage, lane: LoopStage, baseline: StepSnapshot, attempt: number): Promise<{ end: LoopRunOutcome } | { result: StepReviewResult }> => {
    const reviewer = deps.reviewStep;
    if (!reviewer) return { result: { verdict: "skipped", findings: "", reason: "no reviewer" } };
    deps.onProgress?.({ type: "step-review", stage: lane, phase: "reviewing", attempt });
    const review = await reviewer(stage, baseline, attempt);
    spentUsd += review.usage?.costUsd ?? 0;
    const ceilingAfterReview = ceilingOutcome(lane);
    if (ceilingAfterReview) return { end: ceilingAfterReview };
    const haltAfterReview = haltedOutcome();
    if (haltAfterReview) return { end: haltAfterReview };
    if (deps.isCancelled?.()) return { end: cancelledOutcome() };
    if (expired()) return { end: { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "wall-clock budget reached" } };
    return { result: review };
  };
  /**
   * Reviews one passed step and repairs its findings within the step's own budget. Returns the outcome that ends the
   * run (cost ceiling, halt, cancel), or null to carry on. A null baseline means no diff can be isolated: skipped.
   */
  const reviewPassedStep = async (stage: LoopStage, baseline: StepSnapshot | null): Promise<LoopRunOutcome | null> => {
    const reviewer = deps.reviewStep;
    if (!reviewer) return null;
    if (baseline === null) return endStepReview(stage, "skipped", 0, "", "no baseline snapshot, so the step's diff cannot be isolated");
    let attempts = 0;
    let lastSignature: string | null = null;
    let nonImproving = 0;
    for (;;) {
      const reviewed = await reviewOnce(stage, stage, baseline, attempts + 1);
      if ("end" in reviewed) return reviewed.end;
      const review = reviewed.result;
      if (review.verdict === "approve") { await endStepReview(stage, "approve", attempts, ""); return null; }
      if (review.verdict === "skipped") { await endStepReview(stage, "skipped", attempts, "", review.reason ?? "review skipped"); return null; }
      const used = reviews.repairs.get(stage.id) ?? 0;
      if (used >= Math.max(1, config.maxRepairsPerStage)) { await endStepReview(stage, "unresolved", attempts, review.findings, "repair budget exhausted"); return null; }
      // Pause and Stop hold before a review repair, as they do before a stage repair.
      const heldBeforeFix = await heldOutcome();
      if (heldBeforeFix) return heldBeforeFix;
      if (deps.isCancelled?.()) return cancelledOutcome();
      deps.onProgress?.({ type: "step-review", stage, phase: "fixing", attempt: used + 1 });
      deps.log(`↻ fixing review findings in ${stage.name} (attempt ${used + 1} of ${Math.max(1, config.maxRepairsPerStage)})`);
      const fix = await deps.repair(stage, review.findings, used + 1, { review: true });
      spentUsd += fix.usage?.costUsd ?? 0;
      reviews.repairs.set(stage.id, used + 1);
      attempts += 1;
      const ceilingAfterFix = ceilingOutcome(stage);
      if (ceilingAfterFix) return ceilingAfterFix;
      const haltAfterFix = haltedOutcome();
      if (haltAfterFix) return haltAfterFix;
      if (deps.isCancelled?.()) return cancelledOutcome();
      // Reviews and repairs can loop for a long time; the wall-clock budget ends the run here as it does between stages.
      if (expired()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "wall-clock budget reached" };
      if (!fix.ok) { await endStepReview(stage, "unresolved", attempts, review.findings, "repair did not complete"); return null; }
      // Same non-improving rule as a stage repair: findings that repeat across repairs mean the repair is not working.
      const signature = review.findings.trim().slice(0, 2000);
      nonImproving = signature === lastSignature ? nonImproving + 1 : 1;
      lastSignature = signature;
      if (nonImproving >= Math.max(1, config.consecutiveFailureStop)) {
        await endStepReview(stage, "unresolved", attempts, review.findings, `findings did not change across ${nonImproving} repairs`);
        return null;
      }
    }
  };

  for (let iteration = 1; iteration <= clampIterations(config.maxIterations); iteration++) {
    const heldAtStart = await heldOutcome();
    if (heldAtStart) return heldAtStart;
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    if (expired()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "wall-clock budget reached" };
    const haltAtStart = haltedOutcome();
    if (haltAtStart) return haltAtStart;
    iterationsUsed = iteration;
    deps.log(`— iteration ${iteration} of ${clampIterations(config.maxIterations)} —`);
    deps.onProgress?.({ type: "iteration", iteration });
    const iterationOutcomes: StageOutcome[] = [];
    let failed: StageOutcome | null = null;
    let trigger: { group: LoopbackGroup; verify: LoopStage; source: "tests" | "review"; text: string } | null = null;
    for (const stage of stages) {
      if (runsOncePerRun(stage) && passedOnce.has(stage.id)) {
        deps.log(`↷ ${stage.name}: passed earlier in this run`);
        deps.onProgress?.({ type: "stage-skipped", stage, index: stages.indexOf(stage) + 1, count: stages.length, iteration });
        continue;
      }
      if (stageRan) await pauseBetween(deps, config.stageDelaySeconds);
      const heldAtStage = await heldOutcome();
      if (heldAtStage) return heldAtStage;
      if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
      if (expired()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "wall-clock budget reached" };
      const haltAtStage = haltedOutcome();
      if (haltAtStage) return haltAtStage;
      deps.onProgress?.({ type: "stage-start", stage, index: stages.indexOf(stage) + 1, count: stages.length, iteration });
      const codeGroup = groupOfCode(groups, stage.id);
      const verifyGroup = groupOfVerify(groups, stage.id);
      const groupHead = codeGroup?.codeStages[0];
      // A grouped code stage is reviewed once its Verify passes, so it never takes the in-place review below.
      if (codeGroup && groupHead && stage.id === groupHead.id && deps.reviewStep && !reviews.closed.has(groupHead.id) && !groupBaseline.has(codeGroup.closerId)) {
        groupBaseline.set(codeGroup.closerId, deps.snapshotBefore ? await deps.snapshotBefore(stage) : null);
      }
      // The baseline is taken before the stage writes anything, so its review sees only this stage's diff.
      const isReviewed = codeGroup === null && deps.reviewStep !== undefined && effectiveReviewAfter(stage) && !reviews.closed.has(stage.id);
      const baseline = isReviewed ? (deps.snapshotBefore ? await deps.snapshotBefore(stage) : null) : undefined;
      const t0 = Date.now();
      const loopbackContext: LoopbackContext | undefined = codeGroup && (groupFindings.get(codeGroup.closerId)?.length ?? 0) > 0 ? { round: iteration, maxRounds, findings: findingsText(groupFindings.get(codeGroup.closerId) ?? []) } : undefined;
      const result = await deps.runStage(stage, outcomes, loopbackContext);
      stageRan = true;
      const outcome = { stage, ok: result.ok, output: result.output, durationMs: result.durationMs ?? Date.now() - t0, usage: result.usage };
      spentUsd += result.usage?.costUsd ?? 0;
      outcomes.push(outcome);
      iterationOutcomes.push(outcome);
      deps.onProgress?.({ type: "stage-result", stage, ok: result.ok, iteration, durationMs: outcome.durationMs ?? 0, costUsd: result.usage?.costUsd });
      deps.log(`${result.ok ? "✓" : "✗"} ${stage.name}: ${result.ok ? "passed" : "failed"}`);
      if (result.ok && runsOncePerRun(stage)) passedOnce.add(stage.id);
      if (result.ok && codeGroup && groupHead && deps.reviewStep && !reviews.closed.has(groupHead.id)) reviewDue.add(codeGroup.closerId);
      if (config.maxCostUsd !== null && spentUsd >= config.maxCostUsd) {
        return { passed: false, iterationsUsed, stages: outcomes, iterations, failedStage: stage, statusSummary: `cost ceiling reached ($${spentUsd.toFixed(2)} of $${config.maxCostUsd})`, costUsd: spentUsd };
      }
      // Only a passed step is reviewed: a failed one goes through the stage's own repair path instead.
      if (result.ok && baseline !== undefined) {
        // A halt or Stop that arrived during the stage must end the run before a review agent starts and spends money.
        const haltBeforeReview = haltedOutcome();
        if (haltBeforeReview) return haltBeforeReview;
        if (deps.isCancelled?.()) return cancelledOutcome();
        const endedByReview = await reviewPassedStep(stage, baseline);
        if (endedByReview) return endedByReview;
      }
      if (!result.ok && stage.severity === "blocking" && verifyGroup) {
        // Tests failed after a code stage: go back to that stage with the output instead of handing it to a repair agent.
        reviewDue.delete(verifyGroup.closerId);
        trigger = { group: verifyGroup, verify: stage, source: "tests", text: result.output };
        break;
      }
      if (result.ok && verifyGroup && stage.id === verifyGroup.closerId && reviewDue.has(verifyGroup.closerId) && deps.reviewStep) {
        const head = verifyGroup.codeStages[0];
        const groupBase = groupBaseline.get(verifyGroup.closerId) ?? null;
        reviewDue.delete(verifyGroup.closerId);
        const haltBeforeGroupReview = haltedOutcome();
        if (haltBeforeGroupReview) return haltBeforeGroupReview;
        if (deps.isCancelled?.()) return cancelledOutcome();
        const attempts = groupAttempts.get(verifyGroup.closerId) ?? 0;
        if (groupBase === null) {
          deps.onProgress?.({ type: "step-review", stage, phase: "reviewing", attempt: attempts + 1 });
          await endStepReview(head, "skipped", attempts, "", "no baseline snapshot, so the step's diff cannot be isolated");
          groupBaseline.delete(verifyGroup.closerId);
        } else {
          const reviewed = await reviewOnce(head, stage, groupBase, attempts + 1);
          if ("end" in reviewed) return reviewed.end;
          const review = reviewed.result;
          if (review.verdict === "approve") {
            await endStepReview(head, "approve", attempts, "");
            groupBaseline.delete(verifyGroup.closerId); groupAttempts.delete(verifyGroup.closerId);
          } else if (review.verdict === "skipped") {
            await endStepReview(head, "skipped", attempts, "", review.reason ?? "review skipped");
            groupBaseline.delete(verifyGroup.closerId); groupAttempts.delete(verifyGroup.closerId);
          } else {
            groupAttempts.set(verifyGroup.closerId, attempts + 1);
            trigger = { group: verifyGroup, verify: stage, source: "review", text: review.findings };
            break;
          }
        }
      }
      if (!result.ok && stage.severity === "blocking") { failed = outcome; break; }
      const haltAfterStage = haltedOutcome();
      if (haltAfterStage) return haltAfterStage;
    }
    if (trigger) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      const haltAfterRound = haltedOutcome();
      if (haltAfterRound) return haltAfterRound;
      if (deps.isCancelled?.()) return cancelledOutcome();
      const code = trigger.group.codeStages[0];
      const entry: FindingsEntry = { round: iteration, source: trigger.source, text: headAndTail(trigger.text, 12_000) };
      const signature = failureSignature(trigger.source, trigger.text);
      unchanged = signature === loopSignature ? unchanged + 1 : 1;
      loopSignature = signature;
      const noChange = unchanged >= LOOPBACK_IDENTICAL_STOP;
      // Rounds remained when only the no-change rule fired; the recorded reason must say so, not "round limit".
      const stoppedEarly = iteration < maxRounds && noChange;
      if (iteration >= maxRounds || noChange) {
        if (trigger.source === "review") await endStepReview(code, "unresolved", groupAttempts.get(trigger.group.closerId) ?? 0, trigger.text, stoppedEarly ? "no change since the previous round" : "round limit reached");
        const summary = stoppedSummary(iteration, trigger.source, stoppedEarly);
        deps.log(summary);
        return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: trigger.verify, statusSummary: summary, stoppedAtLimit: true, loopback: { rounds: iteration, maxRounds, reason: trigger.source, findings: findingsText(findings.concat(entry)), stopped: true } };
      }
      const heldAfterRound = await heldOutcome();
      if (heldAfterRound) return heldAfterRound;
      findings.push(entry);
      groupFindings.set(trigger.group.closerId, [...(groupFindings.get(trigger.group.closerId) ?? []), entry]);
      try { await deps.recordFindings?.(code, entry); } catch (e) { deps.log(`could not record the round's findings: ${e instanceof Error ? e.message : String(e)}`); }
      for (const codeStage of trigger.group.codeStages) passedOnce.delete(codeStage.id);
      deps.onProgress?.({ type: "loopback", stage: trigger.verify, round: iteration, maxRounds, reason: trigger.source });
      deps.log(`↻ round ${iteration} of ${maxRounds} failed (${trigger.source}); back to ${code.name}`);
      continue;
    }
    if (!failed) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      return { passed: true, iterationsUsed, stages: outcomes, iterations, failedStage: null, costUsd: spentUsd, statusSummary: `passed after ${iterationsUsed} iteration${iterationsUsed === 1 ? "" : "s"}` };
    }
    // A halt raised by the blocking stage itself (its agent call wrote something it must not) ends the run before any repair.
    const haltAfterFailure = haltedOutcome();
    if (haltAfterFailure) { iterations.push({ index: iteration, stages: iterationOutcomes, repair: null }); return haltAfterFailure; }
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    const used = repairs.get(failed.stage.id) ?? 0;
    // Only an explicit false disables repair: an in-memory template stage carries no allowsRepair at all.
    if (failed.stage.allowsRepair === false) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair is disabled for this stage` };
    }
    if (used >= Math.max(1, config.maxRepairsPerStage)) {
      iterations.push({ index: iteration, stages: iterationOutcomes, repair: null });
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair budget exhausted` };
    }
    // Pause holds before a repair attempt too, as it does between stages; Stop while paused ends the run here.
    const heldBeforeRepair = await heldOutcome();
    if (heldBeforeRepair) return heldBeforeRepair;
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    deps.onProgress?.({ type: "repair", stage: failed.stage, attempt: used + 1 });
    deps.log(`↻ repairing ${failed.stage.name} (attempt ${used + 1} of ${Math.max(1, config.maxRepairsPerStage)})`);
    const repair = await deps.repair(failed.stage, failed.output, used + 1);
    spentUsd += repair.usage?.costUsd ?? 0;
    if (config.maxCostUsd !== null && spentUsd >= config.maxCostUsd) {
      return { passed: false, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `cost ceiling reached ($${spentUsd.toFixed(2)} of $${config.maxCostUsd})`, costUsd: spentUsd };
    }
    repairs.set(failed.stage.id, used + 1);
    iterations.push({ index: iteration, stages: iterationOutcomes, repair: { stageId: failed.stage.id, attempt: used + 1, ok: repair.ok } });
    const haltAfterRepair = haltedOutcome();
    if (haltAfterRepair) return haltAfterRepair;
    if (deps.isCancelled?.()) return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: null, statusSummary: "run cancelled", cancelled: true };
    if (!repair.ok) {
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed; repair did not complete` };
    }
    const signature = failed.output.trim().slice(0, 2000);
    if (signature === lastFailure) nonImproving += 1; else nonImproving = 1;
    lastFailure = signature;
    if (nonImproving >= Math.max(1, config.consecutiveFailureStop)) {
      return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: failed.stage, statusSummary: `${failed.stage.name} failed ${nonImproving} times without improvement` };
    }
  }
  const last = outcomes[outcomes.length - 1] ?? null;
  return { passed: false, costUsd: spentUsd, iterationsUsed, stages: outcomes, iterations, failedStage: last?.stage ?? null, statusSummary: `max iterations (${iterationsUsed}) reached` };
}

/**
 * The run record's `statusCode`, as the Mac writes it: a halt that blocked the run is `blocked.repair_out_of_scope`; a Stop
 * or a pause that timed out is `aborted` (the Mac's `LoopEngineStatus.aborted`); an agent call that failed with nothing out
 * of scope is `error`; otherwise `success` or `failed`.
 */
export function runStatusCode(o: Pick<LoopRunOutcome, "passed" | "cancelled" | "blocked" | "errored" | "stoppedAtLimit"> & { awaitingReview?: boolean }): string {
  // Held for a person: checked first so no later code mistakes the run for success and ships it.
  if (o.awaitingReview) return "awaiting_review";
  if (o.blocked) return "blocked.repair_out_of_scope";
  if (o.errored) return "error";
  if (o.cancelled) return "aborted";
  if (o.stoppedAtLimit) return LOOPBACK_STOPPED_CODE;
  return o.passed ? "success" : "failed";
}
