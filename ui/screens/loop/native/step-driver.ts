// The several-steps-per-run driver the Refactoring (`R<n>` batches) and Test (`T<n>` steps) loops share. The planning stages
// run once; then each `(status: todo)` step in the plan gets its own run of the step stages, with a checkpoint of the
// worktree before it. A step that fails is rolled back to that checkpoint and marked blocked in the plan; a step that
// passed stays, even when a later one is rolled back. A user Stop is not rolled back: the person is looking at the tree.
// What differs between the loops is one StepRecipe: refactor batches depend on each other (one blocked batch ends the
// run), test steps do not (the run goes on, up to a streak of blocked ones).
import { isSetupStage } from "./loop-setup.ts";
import { MAX_STEPS_PER_RUN, type LoopEngineConfig, type LoopStage } from "./model.ts";
import { pauseBetween, runBudget, runNativeLoop, stepReviewNote, type LoopIterationOutcome, type LoopRunOutcome, type RunnerDeps, type StageOutcome, type StepReviewOutcome } from "./runner.ts";

export interface StepDriverOpts {
  maxBatches?: number;
  /** A tree id of the worktree's current state (no commit). */
  checkpoint(): Promise<string>;
  /** Returns the worktree to a tree from `checkpoint`. */
  restore(tree: string): Promise<void>;
  /** The plan text, or null when there is no plan file. */
  readPlan(): Promise<string | null>;
  writePlan(text: string): Promise<void>;
  log(line: string): void;
}

export interface StepRecipe {
  /** The step heading prefix: `### R1 …` or `### T1 …`. */
  prefix: string;
  planningKeys: ReadonlySet<string>;
  stepKeys: ReadonlySet<string>;
  stepSkills: ReadonlySet<string>;
  /** The driver applies only while this skill stage is enabled; else the loop only plans and checks, as one loop. */
  applySkill: string;
  /** defaultKeys tried in order for the pre-run test baseline (none = no baseline gate). */
  baselineKeys: readonly string[];
  /** A failure at this stage says nothing about the step itself: it is restored and left todo. */
  baselineStageKey: string | null;
  /** Run the baseline after planning and only to learn whether the suite was already red (see runSteps). */
  baselineAfterPlanning?: boolean;
  /** Run every step stage with repair off and in one round (see runSteps). */
  noRepair?: boolean;
  /** Skip a step's checks (the stages after its apply skill) when the agent marked it skipped and changed no file. */
  skipChecksWhenSkipped?: boolean;
  /** With baselineAfterPlanning: whether the plan says tests already exist. A red suite that exists stops the run before any step. */
  suiteExists?: (planText: string) => boolean;
  /** Steps per run asked of the config (null = the default 3). */
  limitOf(config: LoopEngineConfig): number | null;
  /** Log and summary words. */
  noun: string;
  nouns: string;
  /** "applied" for a refactor batch, "done" for a test step. */
  doneWord: string;
  /** Mark the failed step by its id in any status (a test step the agent already marked done), not "the first todo". */
  blockById: boolean;
  /** Steps are independent: after a blocked step go on with the next, up to this many in a row (0 = stop at the first). */
  blockedStreak: number;
  /** When the plan has no todo step but this run applied some, re-run the planning stages once: the plan may open a next area. */
  replanWhenDone?: boolean;
}

const headerOf = (r: StepRecipe) => new RegExp(`^###\\s+(${r.prefix}\\d+)\\b.*\\(status:\\s*(todo|done|skipped|blocked)\\)\\s*$`);

/**
 * Splits the stages into the planning phase and the step phase by defaultKey. A stage with no known key (a user's) keeps
 * its position: before the first step stage it plans, from there on it runs per step.
 */
export function splitPhases(r: StepRecipe, stages: readonly LoopStage[]): { planning: LoopStage[]; batch: LoopStage[] } {
  const firstBatch = stages.findIndex((s) => s.defaultKey !== null && r.stepKeys.has(s.defaultKey));
  const firstBatchSkill = stages.findIndex((s) => r.stepSkills.has(s.skillId ?? ""));
  const split = firstBatch >= 0 ? firstBatch : firstBatchSkill >= 0 ? firstBatchSkill : stages.length;
  const planning: LoopStage[] = [];
  const batch: LoopStage[] = [];
  stages.forEach((s, i) => {
    const key = s.defaultKey ?? "";
    const isPlanning = r.planningKeys.has(key) || (!r.stepKeys.has(key) && i < split);
    (isPlanning ? planning : batch).push(s);
  });
  return { planning, batch };
}

/** The first `(status: todo)` step in the plan, or null. */
export function nextTodo(r: StepRecipe, plan: string | null): { id: string } | null {
  if (plan === null) return null;
  const header = headerOf(r);
  for (const line of plan.split("\n")) {
    const m = header.exec(line);
    if (m && m[2] === "todo") return { id: m[1] };
  }
  return null;
}

/** The status of step `id` in the plan, or null when the plan has no such header. */
function stepStatus(r: StepRecipe, plan: string | null, id: string): string | null {
  if (plan === null) return null;
  const header = headerOf(r);
  for (const line of plan.split("\n")) {
    const m = header.exec(line);
    if (m && m[1] === id) return m[2];
  }
  return null;
}

/** The plan with step `id` marked blocked, and the reason as a line right under its header. */
function markBlocked(r: StepRecipe, plan: string, id: string, reason: string, anyStatus = false): string {
  const header = headerOf(r);
  const lines = plan.split("\n");
  const at = lines.findIndex((line) => { const m = header.exec(line); return m !== null && m[1] === id && (anyStatus || m[2] === "todo"); });
  if (at < 0) return plan;
  lines[at] = lines[at].replace(/\(status:\s*\w+\)/, "(status: blocked)");
  lines.splice(at + 1, 0, `- Blocked: ${reason}`);
  return lines.join("\n");
}

/** Re-plans one run may make (each opens at most one more area). */
const MAX_REPLANS = 3;

/** The planner's end-of-roadmap marker, in the plan's first lines: nothing is left to re-plan. */
const ALL_DONE = /^All areas are done\./m;

/** The plan with step `id` set to `status` (any current status), and `line` added under its header when given. */
function setStatus(r: StepRecipe, plan: string, id: string, status: string, line?: string): string {
  const header = headerOf(r);
  const lines = plan.split("\n");
  const at = lines.findIndex((l) => header.exec(l)?.[1] === id);
  if (at < 0) return plan;
  lines[at] = lines[at].replace(/\(status:\s*\w+\)/, `(status: ${status})`);
  if (line) lines.splice(at + 1, 0, line);
  return lines.join("\n");
}

/** `now` with every step except `own` put back to the status it had in `before`: a step may only mark itself. */
function keepOtherMarks(r: StepRecipe, before: string, now: string, own: string): string {
  const header = headerOf(r);
  const was = new Map<string, string>();
  for (const line of before.split("\n")) { const m = header.exec(line); if (m) was.set(m[1], m[2]); }
  return now.split("\n").map((line) => {
    const m = header.exec(line);
    const old = m && m[1] !== own ? was.get(m[1]) : undefined;
    return m && old !== undefined && old !== m[2] ? line.replace(/\(status:\s*\w+\)/, `(status: ${old})`) : line;
  }).join("\n");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function runSteps(r: StepRecipe, config: LoopEngineConfig, deps: RunnerDeps, opts: StepDriverOpts): Promise<LoopRunOutcome> {
  const requested = opts.maxBatches ?? r.limitOf(config) ?? 3;
  const max = Number.isFinite(requested) ? Math.min(MAX_STEPS_PER_RUN, Math.max(1, Math.trunc(requested))) : 3;
  // A loop that applies nothing (no test command, or Apply turned off) only plans and checks: run it as one loop.
  if (!config.stages.some((s) => s.enabled && s.kind === "skill" && s.skillId === r.applySkill)) return runNativeLoop(config, deps);
  const { planning, batch } = splitPhases(r, config.stages);
  const snapshot = planning.filter((s) => s.kind === "codeGraph" && s.graphOp === "snapshot");

  const { remaining, exhausted } = runBudget(config);
  const budgetStop = (summary: string) => /^(wall-clock budget reached|cost ceiling reached)/.test(summary);

  // Nothing is planned or changed until the tests can start and pass: a red baseline here means the test command or the tree.
  // Only a test stage is a baseline: a custom lint or build step must never become this gate.
  const baseline = r.baselineKeys.map((key) => config.stages.find((s) => s.enabled && s.kind === "shellCommand" && s.defaultKey === key)).find((s) => s !== undefined) ?? null;
  // Its own name, so the run record and the issue trail tell it apart from the step's own Test Baseline.
  const preCheck = (spent: number) => runNativeLoop({ ...config, ...remaining(spent), maxIterations: 1, stages: [{ ...baseline!, name: `${baseline!.name} (pre-check)`, allowsRepair: false }] }, deps);
  const pre = baseline && !r.baselineAfterPlanning ? await runNativeLoop({ ...config, ...remaining(0), maxIterations: 1, stages: [{ ...baseline, name: `${baseline.name} (pre-check)`, allowsRepair: false }] }, deps) : null;
  if (pre?.cancelled) return pre;
  if (baseline && pre && !pre.passed) {
    return {
      passed: false,
      iterationsUsed: pre.iterationsUsed,
      stages: pre.stages,
      iterations: pre.iterations,
      costUsd: pre.costUsd ?? 0,
      failedStage: baseline,
      statusSummary: `the tests do not pass before any change, so nothing was planned or applied: ${baseline.name} failed — fix the test command or the failing tests first`,
      ...(pre.errored ? { errored: true } : {}),
    };
  }
  const preCost = pre?.costUsd ?? 0;
  if (pre) await pauseBetween(deps, config.stageDelaySeconds);

  const plan = await runNativeLoop({ ...config, ...remaining(preCost), stages: planning }, deps);
  const stages: StageOutcome[] = [...(pre?.stages ?? []), ...plan.stages];
  const iterations: LoopIterationOutcome[] = [...(pre?.iterations ?? []), ...plan.iterations];
  let iterationsUsed = (pre?.iterationsUsed ?? 0) + plan.iterationsUsed;
  let costUsd = preCost + (plan.costUsd ?? 0);
  if (!plan.passed) return { ...plan, stages, iterations: iterations.map((it, i) => ({ ...it, index: i + 1 })), iterationsUsed, costUsd };
  // A recipe whose planning can create the test layout checks the suite only now, and only to learn whether it was
  // already red: then a step that fails at the test stage is left todo and ends the run, instead of good steps being
  // rolled back and blocked one after another. A red (or empty) suite does not stop the first step from running.
  let redBefore = false;
  if (baseline && r.baselineAfterPlanning) {
    await pauseBetween(deps, config.stageDelaySeconds);
    const check = await preCheck(costUsd);
    stages.push(...check.stages);
    iterations.push(...check.iterations);
    iterationsUsed += check.iterationsUsed;
    costUsd += check.costUsd ?? 0;
    if (check.cancelled) return { ...check, stages, iterations: iterations.map((it, i) => ({ ...it, index: i + 1 })), iterationsUsed, costUsd };
    redBefore = !check.passed;
    if (redBefore) opts.log(`${baseline.name} was already failing before any ${r.noun}.`);
    const planNow = redBefore && r.suiteExists ? await opts.readPlan() : null;
    if (planNow !== null && r.suiteExists!(planNow)) {
      return { passed: false, iterationsUsed, stages, iterations: iterations.map((it, i) => ({ ...it, index: i + 1 })), costUsd, failedStage: baseline, statusSummary: `the tests were already failing before any ${r.noun}, so none was run: ${baseline.name} failed — fix the failing tests first`, ...(check.errored ? { errored: true } : {}), ...(plan.stepReviews?.length ? { stepReviews: plan.stepReviews } : {}) };
    }
  }
  let last: LoopRunOutcome = plan;
  const applied: string[] = [];
  const skipped: string[] = [];
  const rolledBack: { id: string; reason: string; leftTodo: boolean }[] = [];
  let blockedStreak = 0;
  // Every batch is its own runNativeLoop, so its review outcomes are gathered here or the outer run would report none.
  const stepReviews: StepReviewOutcome[] = [...(plan.stepReviews ?? [])];
  let failed = false;
  let hostError = false;
  let note = "";
  // The checkpoint of the batch in flight, until it passed or was restored: a host error mid-batch restores it.
  let pending: string | null = null;
  // Planning stages again for a re-plan: the one-time dependency Setup and any runOnce stage already ran in this run.
  const replanStages = planning.filter((s) => !s.runOnce && !isSetupStage(s));
  let replanned = false;
  let replans = 0;

  try {
  for (let k = 1; ; k++) {
    const planText = await opts.readPlan();
    if (planText === null) { note = "the plan file is missing after planning"; failed = true; break; }
    let todo = nextTodo(r, planText);
    // Only a plan divided into areas has a next area to open, and at most MAX_REPLANS times a run: a planner that
    // keeps finding one more batch must not re-plan (graph, test map, planner) until the step limit.
    if (!todo && r.replanWhenDone && !replanned && replans < MAX_REPLANS && /^- Area:/m.test(planText) && applied.length + skipped.length > 0 && k <= max && !exhausted(remaining(costUsd)) && !ALL_DONE.test(planText.split("\n").slice(0, 15).join("\n"))) {
      replanned = true;
      replans += 1;
      opts.log(`— re-planning: the plan has no todo ${r.nouns} left —`);
      await pauseBetween(deps, config.stageDelaySeconds);
      const re = await runNativeLoop({ ...config, ...remaining(costUsd), stages: replanStages }, deps);
      stages.push(...re.stages);
      iterations.push(...re.iterations);
      iterationsUsed += re.iterationsUsed;
      costUsd += re.costUsd ?? 0;
      stepReviews.push(...(re.stepReviews ?? []));
      // A failed re-plan keeps the applied batches (the run still passes); a Stop is a Stop.
      if (re.cancelled) { last = re; note = re.statusSummary; break; }
      if (!re.passed) { failed = true; note = `re-plan failed: ${oneLine(re.statusSummary)}`; break; }
      todo = nextTodo(r, await opts.readPlan());
      if (!todo) { note = `plan complete: no todo ${r.nouns} left`; break; }
    }
    if (!todo) { note = applied.length ? "" : `no todo ${r.nouns} in the plan`; break; }
    if (k > max) { note = `${r.noun} limit (${max}) reached`; break; }
    const left = remaining(costUsd);
    const out = exhausted(left);
    if (out) { note = `${out}; ${todo.id} and later ${r.nouns} stay todo`; break; }
    opts.log(`— ${r.noun} ${todo.id} (${k} of ${max}) —`);
    // Every batch starts after a stage boundary: batch 1 after planning, a later one after the previous batch.
    await pauseBetween(deps, config.stageDelaySeconds);
    const tree = await opts.checkpoint();
    pending = tree;
    // A later batch retakes the baseline from the tree the previous batch left, so its graph check judges only itself.
    // A recipe that only adds files never repairs a failed step: the generic repair agent may change source and build
    // config until the suite is green, which is exactly what such a step must not do. It gets one round too: a second
    // round would re-run the apply skill, whose step is already marked, so it would take the NEXT step, and the guard
    // would not let it rewrite the test file it made. The step fails, is rolled back and blocked with the failure as
    // its reason.
    const stepStages = (k === 1 ? batch : [...snapshot, ...batch]).map((s) => (r.noRepair ? { ...s, allowsRepair: false } : s));
    // A step the agent skipped without writing anything has nothing to check: the run ends after the apply skill, so
    // its Test, map and prune stages (a full suite run each time) are not run. Any other step runs all its stages.
    const stepDeps: RunnerDeps = !r.skipChecksWhenSkipped ? deps : {
      ...deps,
      async endAfter(stage) {
        if (!(stage.kind === "skill" && stage.skillId === r.applySkill)) return false;
        const untouched = stepStatus(r, await opts.readPlan(), todo.id) === "skipped" && (await opts.checkpoint()) === tree;
        if (untouched) opts.log(`${todo.id} was skipped and changed nothing: its checks are not run`);
        return untouched;
      },
    };
    const sub = await runNativeLoop({ ...config, ...left, ...(r.noRepair ? { maxIterations: 1 } : {}), stages: stepStages }, stepDeps);
    stages.push(...sub.stages);
    iterations.push(...sub.iterations);
    iterationsUsed += sub.iterationsUsed;
    costUsd += sub.costUsd ?? 0;
    stepReviews.push(...(sub.stepReviews ?? []));
    last = sub;
    replanned = false;
    // "Touch no other step" is only asked of the agent. A mark it put on another step would hide that step's work
    // for good (only todo steps are ever re-read), so every other step's status is put back.
    if (r.blockById) {
      const now = await opts.readPlan();
      const kept = now === null ? null : keepOtherMarks(r, planText, now, todo.id);
      if (now !== null && kept !== now) { await opts.writePlan(kept!); opts.log(`${todo.id} changed the marks of other ${r.nouns}; they were put back`); }
    }

    if (sub.cancelled) { pending = null; note = sub.statusSummary; break; }
    if (sub.passed) {
      pending = null;
      const status = stepStatus(r, await opts.readPlan(), todo.id);
      blockedStreak = 0;
      redBefore = false;
      if (status === "done") { applied.push(todo.id); continue; }
      if (status === "skipped") { skipped.push(todo.id); continue; }
      // Independent steps: a run that passed without marking its step (an edited prompt, a forgetful agent) must not
      // stall every later run on the same step. It is written off as skipped and the run goes on.
      if (r.blockById && status === "todo") {
        const now = await opts.readPlan();
        if (now !== null) await opts.writePlan(setStatus(r, now, todo.id, "skipped", "- Skipped: its run passed but did not mark the step"));
        skipped.push(todo.id);
        continue;
      }
      // The batch passed but the plan does not say it was applied: stop rather than apply the same batch again.
      note = `${todo.id} is still ${status ?? "missing"} after its run; stopped`;
      failed = true;
      break;
    }

    failed = true;
    const reason = oneLine(sub.statusSummary);
    // A red Test Baseline or a failed agent/transport call says nothing about the step itself: it is restored and left
    // todo to be retried as-is. Anything else blocks it, so the next plan works around it.
    const suiteWasRed = redBefore && r.baselineKeys.includes(sub.failedStage?.defaultKey ?? "");
    const leftTodo = sub.errored === true || (r.baselineStageKey !== null && sub.failedStage?.defaultKey === r.baselineStageKey) || budgetStop(sub.statusSummary) || suiteWasRed;
    pending = null;
    try {
      await opts.restore(tree);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rolledBack.push({ id: todo.id, reason, leftTodo: false });
      note = `rollback failed: ${oneLine(message)}; the worktree may hold ${todo.id}`;
      opts.log(`✗ ${note}`);
      // The tree may still hold the half-applied batch, possibly with the plan already saying done: block it in the
      // plan too (whatever its status now) so no later run treats it as applied or retries it on a dirty tree.
      try {
        const current = await opts.readPlan();
        if (current !== null) await opts.writePlan(markBlocked(r, current, todo.id, `rollback failed — ${reason}`, true));
      } catch { /* the summary line above is all that is left */ }
      break;
    }
    rolledBack.push({ id: todo.id, reason, leftTodo });
    const stageName = sub.failedStage?.name ?? "run";
    if (leftTodo) {
      // The plan lives in a state folder the restore does not revert: the agent may already have marked the step done.
      if (r.blockById) {
        const now = await opts.readPlan();
        if (now !== null) await opts.writePlan(setStatus(r, now, todo.id, "todo"));
      }
      opts.log(`⊘ ${todo.id} rolled back to before the ${r.noun} and left todo: ${stageName} — ${reason}`);
      break;
    }
    const current = await opts.readPlan();
    const blockId = r.blockById ? todo.id : nextTodo(r, current)?.id;
    if (current !== null && blockId) await opts.writePlan(markBlocked(r, current, blockId, `${stageName} — ${reason}`, r.blockById));
    opts.log(`⊘ ${todo.id} rolled back to before the ${r.noun}: ${stageName} — ${reason}`);
    // A halt (a policy violation the run could not undo) stays set for the rest of the run: every later step would
    // end at once with the same reason and be blocked without having run. The run ends here.
    if (sub.blocked) break;
    if (blockedStreak++ + 1 < r.blockedStreak) continue;
    if (r.blockedStreak > 0) note = `${r.blockedStreak} ${r.nouns} in a row were blocked; stopped`;
    break;
  }
  } catch (e) {
    // A host call (checkpoint, restore, plan read/write) failed: end the run as an error with a record, never bare.
    failed = true;
    hostError = true;
    note = `stopped: ${oneLine(e instanceof Error ? e.message : String(e))}`;
    if (pending !== null) {
      try { await opts.restore(pending); note += `; the ${r.noun} in flight was rolled back`; } catch { note += `; the ${r.noun} in flight could not be rolled back`; }
    }
    opts.log(`✗ ${note}`);
  }

  // At least one verified step, or nothing failed (an up-to-date plan, or only skipped steps). A Stop never passes.
  const passed = applied.length > 0 || (!failed && !last.cancelled);
  const n = applied.length;
  const parts = [`${n} ${n === 1 ? r.noun : r.nouns} ${r.doneWord}${n ? ` (${applied.join(", ")})` : ""}`];
  if (skipped.length) parts.push(`${skipped.join(", ")} skipped`);
  for (const b of rolledBack) parts.push(`${b.id} rolled back${b.leftTodo ? " and left todo" : ""}: ${b.reason}`);
  if (note) parts.push(note);
  return {
    passed,
    iterationsUsed,
    stages,
    iterations: iterations.map((it, i) => ({ ...it, index: i + 1 })),
    costUsd,
    failedStage: passed ? null : last.failedStage,
    statusSummary: `${parts.join("; ")}${stepReviewNote(stepReviews)}`,
    ...(stepReviews.length > 0 ? { stepReviews } : {}),
    // A run that kept verified batches is a pass; a later batch's halt is told in the summary, not as a run status.
    ...(last.cancelled ? { cancelled: true } : {}),
    ...(!passed && last.blocked ? { blocked: true } : {}),
    // Carry the sub-run's round-limit stop so the run manager shows the warning state and never ships it.
    ...(!passed && last.stoppedAtLimit ? { stoppedAtLimit: true, ...(last.loopback ? { loopback: last.loopback } : {}) } : {}),
    ...(!passed && (last.errored || hostError) ? { errored: true } : {}),
  };
}
