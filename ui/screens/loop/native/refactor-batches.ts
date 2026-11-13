// The Refactoring loop's several-batches-per-run driver. The planning stages run once; then each `(status: todo)` batch
// in the plan gets its own run of the batch stages, with a checkpoint of the worktree before it. A batch that fails is
// rolled back to that checkpoint and marked blocked in the plan; a batch that passed stays, even when a later one is
// rolled back. A user Stop is not rolled back: the person is looking at the tree.
import type { LoopEngineConfig, LoopStage } from "./model.ts";
import { pauseBetween, runNativeLoop, type LoopIterationOutcome, type LoopRunOutcome, type RunnerDeps, type StageOutcome } from "./runner.ts";

export interface RefactorBatchOpts {
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

const PLANNING_KEYS = new Set(["refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check"]);
const BATCH_KEYS = new Set(["refactor-test-write", "refactor-test-baseline", "refactor-apply", "refactor-conform", "refactor-test", "refactor-ledger", "refactor-graph-check"]);
const BATCH_SKILLS = new Set(["skills/test-gap-writer", "skills/refactor-apply"]);
const HEADER = /^###\s+(R\d+)\b.*\(status:\s*(todo|done|skipped|blocked)\)\s*$/;

/**
 * Splits the stages into the planning phase and the batch phase by defaultKey. A stage with no known key (a user's) keeps
 * its position: before the first batch stage it plans, from there on it runs per batch.
 */
export function splitRefactorPhases(stages: readonly LoopStage[]): { planning: LoopStage[]; batch: LoopStage[] } {
  const firstBatch = stages.findIndex((s) => s.defaultKey !== null && BATCH_KEYS.has(s.defaultKey));
  const firstBatchSkill = stages.findIndex((s) => BATCH_SKILLS.has(s.skillId ?? ""));
  const split = firstBatch >= 0 ? firstBatch : firstBatchSkill >= 0 ? firstBatchSkill : stages.length;
  const planning: LoopStage[] = [];
  const batch: LoopStage[] = [];
  stages.forEach((s, i) => {
    const key = s.defaultKey ?? "";
    const isPlanning = PLANNING_KEYS.has(key) || (!BATCH_KEYS.has(key) && i < split);
    (isPlanning ? planning : batch).push(s);
  });
  return { planning, batch };
}

/** The first `(status: todo)` batch in the plan, or null. */
export function nextTodoBatch(plan: string | null): { id: string } | null {
  if (plan === null) return null;
  for (const line of plan.split("\n")) {
    const m = HEADER.exec(line);
    if (m && m[2] === "todo") return { id: m[1] };
  }
  return null;
}

/** The status of batch `id` in the plan, or null when the plan has no such header. */
function batchStatus(plan: string | null, id: string): string | null {
  if (plan === null) return null;
  for (const line of plan.split("\n")) {
    const m = HEADER.exec(line);
    if (m && m[1] === id) return m[2];
  }
  return null;
}

/** The plan with the first todo batch `id` marked blocked, and the reason as a line right under its header. */
function markBlocked(plan: string, id: string, reason: string): string {
  const lines = plan.split("\n");
  const at = lines.findIndex((line) => { const m = HEADER.exec(line); return m !== null && m[1] === id && m[2] === "todo"; });
  if (at < 0) return plan;
  lines[at] = lines[at].replace(/\(status:\s*todo\)/, "(status: blocked)");
  lines.splice(at + 1, 0, `- Blocked: ${reason}`);
  return lines.join("\n");
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function runRefactorBatches(config: LoopEngineConfig, deps: RunnerDeps, opts: RefactorBatchOpts): Promise<LoopRunOutcome> {
  const requested = opts.maxBatches ?? config.refactorBatchesPerRun ?? 3;
  const max = Number.isFinite(requested) ? Math.min(10, Math.max(1, Math.trunc(requested))) : 3;
  // A loop that applies nothing (no test command, or Apply turned off) only plans and checks: run it as one loop.
  if (!config.stages.some((s) => s.enabled && s.kind === "skill" && s.skillId === "skills/refactor-apply")) return runNativeLoop(config, deps);
  const { planning, batch } = splitRefactorPhases(config.stages);
  const snapshot = planning.filter((s) => s.kind === "codeGraph" && s.graphOp === "snapshot");

  // The wall-clock budget and the cost ceiling are per RUN: each sub-run gets only what is left of them.
  // shortcut: paused time counts against the remaining wall clock here (the runner excludes it within one sub-run).
  const started = Date.now();
  const remaining = (spent: number): { wallClockBudgetSeconds: number | null; maxCostUsd: number | null } => ({
    wallClockBudgetSeconds: config.wallClockBudgetSeconds === null ? null : config.wallClockBudgetSeconds - (Date.now() - started) / 1000,
    maxCostUsd: config.maxCostUsd === null ? null : config.maxCostUsd - spent,
  });
  const exhausted = (r: ReturnType<typeof remaining>): string | null =>
    r.wallClockBudgetSeconds !== null && r.wallClockBudgetSeconds <= 0 ? "wall-clock budget reached"
      : r.maxCostUsd !== null && r.maxCostUsd <= 0 ? "cost ceiling reached" : null;
  const budgetStop = (summary: string) => /^(wall-clock budget reached|cost ceiling reached)/.test(summary);

  // Nothing is planned or changed until the tests can start and pass: a red baseline here means the test command or the tree.
  // Only a test stage is a baseline: a custom lint or build step must never become this gate.
  const baseline = config.stages.find((s) => s.enabled && s.kind === "shellCommand" && s.defaultKey === "refactor-test-baseline")
    ?? config.stages.find((s) => s.enabled && s.kind === "shellCommand" && s.defaultKey === "refactor-test") ?? null;
  // Its own name, so the run record and the issue trail tell it apart from the batch's own Test Baseline.
  const pre = baseline ? await runNativeLoop({ ...config, ...remaining(0), maxIterations: 1, stages: [{ ...baseline, name: `${baseline.name} (pre-check)`, allowsRepair: false }] }, deps) : null;
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
  let last: LoopRunOutcome = plan;
  const applied: string[] = [];
  const skipped: string[] = [];
  let rolledBack: { id: string; reason: string; leftTodo: boolean } | null = null;
  let failed = false;
  let hostError = false;
  let note = "";
  // The checkpoint of the batch in flight, until it passed or was restored: a host error mid-batch restores it.
  let pending: string | null = null;

  try {
  for (let k = 1; ; k++) {
    const planText = await opts.readPlan();
    if (planText === null) { note = "the plan file is missing after planning"; failed = true; break; }
    const todo = nextTodoBatch(planText);
    if (!todo) { note = applied.length ? "" : "no todo batches in the plan"; break; }
    if (k > max) { note = `batch limit (${max}) reached`; break; }
    const left = remaining(costUsd);
    const out = exhausted(left);
    if (out) { note = `${out}; ${todo.id} and later batches stay todo`; break; }
    opts.log(`— batch ${todo.id} (${k} of ${max}) —`);
    // Every batch starts after a stage boundary: batch 1 after planning, a later one after the previous batch.
    await pauseBetween(deps, config.stageDelaySeconds);
    const tree = await opts.checkpoint();
    pending = tree;
    // A later batch retakes the baseline from the tree the previous batch left, so its graph check judges only itself.
    const sub = await runNativeLoop({ ...config, ...left, stages: k === 1 ? batch : [...snapshot, ...batch] }, deps);
    stages.push(...sub.stages);
    iterations.push(...sub.iterations);
    iterationsUsed += sub.iterationsUsed;
    costUsd += sub.costUsd ?? 0;
    last = sub;

    if (sub.cancelled) { pending = null; note = sub.statusSummary; break; }
    if (sub.passed) {
      pending = null;
      const status = batchStatus(await opts.readPlan(), todo.id);
      if (status === "done") { applied.push(todo.id); continue; }
      if (status === "skipped") { skipped.push(todo.id); continue; }
      // The batch passed but the plan does not say it was applied: stop rather than apply the same batch again.
      note = `${todo.id} is still ${status ?? "missing"} after its run; stopped`;
      failed = true;
      break;
    }

    failed = true;
    const reason = oneLine(sub.statusSummary);
    // A red Test Baseline or a failed agent/transport call says nothing about the batch itself: it is restored and left
    // todo to be retried as-is. Anything else blocks it, so the next plan works around it.
    const leftTodo = sub.errored === true || sub.failedStage?.defaultKey === "refactor-test-baseline" || budgetStop(sub.statusSummary);
    pending = null;
    try {
      await opts.restore(tree);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rolledBack = { id: todo.id, reason, leftTodo: false };
      note = `rollback failed: ${oneLine(message)}; the worktree may hold ${todo.id}`;
      opts.log(`✗ ${note}`);
      break;
    }
    rolledBack = { id: todo.id, reason, leftTodo };
    const stageName = sub.failedStage?.name ?? "run";
    if (leftTodo) {
      opts.log(`⊘ ${todo.id} rolled back to before the batch and left todo: ${stageName} — ${reason}`);
      break;
    }
    const current = await opts.readPlan();
    const first = nextTodoBatch(current);
    if (current !== null && first) await opts.writePlan(markBlocked(current, first.id, `${stageName} — ${reason}`));
    opts.log(`⊘ ${todo.id} rolled back to before the batch: ${stageName} — ${reason}`);
    break;
  }
  } catch (e) {
    // A host call (checkpoint, restore, plan read/write) failed: end the run as an error with a record, never bare.
    failed = true;
    hostError = true;
    note = `stopped: ${oneLine(e instanceof Error ? e.message : String(e))}`;
    if (pending !== null) {
      try { await opts.restore(pending); note += "; the batch in flight was rolled back"; } catch { note += "; the batch in flight could not be rolled back"; }
    }
    opts.log(`✗ ${note}`);
  }

  // At least one verified batch, or nothing failed (an up-to-date plan, or only skipped batches). A Stop never passes.
  const passed = applied.length > 0 || (!failed && !last.cancelled);
  const n = applied.length;
  const parts = [`${n} batch${n === 1 ? "" : "es"} applied${n ? ` (${applied.join(", ")})` : ""}`];
  if (skipped.length) parts.push(`${skipped.join(", ")} skipped`);
  if (rolledBack) parts.push(`${rolledBack.id} rolled back${rolledBack.leftTodo ? " and left todo" : ""}: ${rolledBack.reason}`);
  if (note) parts.push(note);
  return {
    passed,
    iterationsUsed,
    stages,
    iterations: iterations.map((it, i) => ({ ...it, index: i + 1 })),
    costUsd,
    failedStage: passed ? null : last.failedStage,
    statusSummary: parts.join("; "),
    // A run that kept verified batches is a pass; a later batch's halt is told in the summary, not as a run status.
    ...(last.cancelled ? { cancelled: true } : {}),
    ...(!passed && last.blocked ? { blocked: true } : {}),
    ...(!passed && (last.errored || hostError) ? { errored: true } : {}),
  };
}
