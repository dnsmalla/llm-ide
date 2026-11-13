import { test } from "node:test";
import assert from "node:assert/strict";
import { runRefactorBatches, splitRefactorPhases, nextTodoBatch } from "../native/refactor-batches.ts";
import { decodeConfig } from "../native/model.ts";

const stage = (id, over = {}) => ({ id, name: id, kind: "shellCommand", order: 0, enabled: true, severity: "blocking", allowsRepair: true, ...over });
const PLAN = stage("plan", { kind: "skill", skillId: "skills/refactor-planner", defaultKey: "refactor-plan" });
const SNAP = stage("snap", { kind: "codeGraph", graphOp: "snapshot", defaultKey: "refactor-graph" });
const WRITE = stage("write", { kind: "skill", skillId: "skills/test-gap-writer", defaultKey: "refactor-test-write" });
const APPLY = stage("apply", { kind: "skill", skillId: "skills/refactor-apply", defaultKey: "refactor-apply" });
const TEST = stage("test", { name: "Refactor Test", defaultKey: "refactor-test" });
const CHECK = stage("check", { kind: "codeGraph", graphOp: "verify", defaultKey: "refactor-graph-check" });

function config(stages, over = {}) {
  return decodeConfig({ stages, maxIterations: 1, maxRepairsPerStage: 1, consecutiveFailureStop: 3, stageDelaySeconds: 0, ...over });
}

const TODO = (id, text = id) => `### ${id} — ${text} (status: todo)\n\n- Files: a.py\n`;

/**
 * A fake run: the planner writes `plan`, refactor-apply marks the first todo batch done, and the Test stage fails when the
 * batch just applied is in `failBatches`. The repair never fixes anything, so a failing Test ends its batch.
 */
function fakeRun({ plan, failBatches = [], cancelAt = null, baselineFails = false, skipBatches = [] }) {
  const state = { plan, ran: [], applied: null, restores: [], checkpoints: 0, written: [], cancelAt, snapshots: {} };
  const deps = {
    async runStage(s) {
      state.ran.push(s.id);
      if (s.id === "plan") state.plan = plan;
      if (s.id === "baseline" && baselineFails) return { ok: false, output: "baseline red" };
      if (s.id === "apply") {
        const id = nextTodoBatch(state.plan)?.id ?? null;
        state.applied = id;
        const to = skipBatches.includes(id) ? "skipped" : "done";
        state.plan = state.plan.replace(`### ${id} — ${id} (status: todo)`, `### ${id} — ${id} (status: ${to})`);
      }
      if (s.id === "test") return failBatches.includes(state.applied) ? { ok: false, output: "1 failed" } : { ok: true, output: "ok" };
      if (cancelAt === s.id) state.cancel = true;
      return { ok: true, output: "" };
    },
    async repair() { return { ok: false, output: "could not fix" }; },
    log() {},
    isCancelled() { return state.cancel === true; },
  };
  const opts = {
    maxBatches: 3,
    async checkpoint() { state.checkpoints += 1; const tree = `tree${state.checkpoints}`; state.snapshots[tree] = state.plan; return tree; },
    async restore(tree) { state.restores.push(tree); state.plan = state.snapshots[tree]; },
    async readPlan() { return state.plan; },
    async writePlan(text) { state.written.push(text); state.plan = text; },
    log() {},
  };
  return { state, deps, opts };
}

const ALL = [PLAN, SNAP, WRITE, APPLY, TEST, CHECK];

test("two todo batches that both pass are applied in one run", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.equal(out.passed, true);
  assert.equal(out.statusSummary, "2 batches applied (R1, R2)");
  assert.match(state.plan, /### R1 — R1 \(status: done\)/);
  assert.match(state.plan, /### R2 — R2 \(status: done\)/);
  assert.deepEqual(state.restores, []);
  assert.equal(out.failedStage, null);
  assert.equal(out.stages.filter((s) => s.stage.id === "apply").length, 2);
});

test("batch 2 failing restores its checkpoint, is marked blocked with a reason, and keeps batch 1", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2"), failBatches: ["R2"] });
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.equal(out.passed, true, "a later rollback does not undo an earlier verified batch");
  assert.deepEqual(state.restores, ["tree2"], "restored to the checkpoint taken before batch 2");
  assert.match(state.plan, /### R1 — R1 \(status: done\)/);
  assert.match(state.plan, /### R2 — R2 \(status: blocked\)\n- Blocked: Refactor Test — Refactor Test failed; repair did not complete\n/);
  assert.match(out.statusSummary, /^1 batch applied \(R1\); R2 rolled back: Refactor Test failed; repair did not complete$/);
});

test("batch 1 failing restores, is blocked, and the run does not pass", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2"), failBatches: ["R1"] });
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.equal(out.passed, false);
  assert.deepEqual(state.restores, ["tree1"]);
  assert.match(state.plan, /### R1 — R1 \(status: blocked\)\n- Blocked: /);
  assert.equal(out.failedStage?.id, "test");
  assert.equal(state.ran.filter((id) => id === "apply").length, 1, "batch 2 is never started");
});

test("a user Stop ends the run without restoring the tree", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2"), failBatches: ["R1"], cancelAt: "apply" });
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.equal(out.cancelled, true);
  assert.equal(out.passed, false);
  assert.deepEqual(state.restores, []);
});

test("a plan with no todo batch runs the planning stages only", async () => {
  const { state, deps, opts } = fakeRun({ plan: "### R1 — x (status: done)\n" });
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.deepEqual(state.ran, ["plan", "snap"]);
  assert.equal(out.passed, true, "an up-to-date plan is not a failure");
  assert.equal(out.statusSummary, "0 batches applied; no todo batches in the plan");
});

test("maxBatches caps the batches per run and the rest stay todo", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") + "\n" + TODO("R3") });
  const out = await runRefactorBatches(config(ALL), deps, { ...opts, maxBatches: 2 });
  assert.equal(out.passed, true);
  assert.equal(out.statusSummary, "2 batches applied (R1, R2); batch limit (2) reached");
  assert.match(state.plan, /### R3 — R3 \(status: todo\)/);
});

test("maxBatches defaults to the config's refactorBatchesPerRun and is clamped to 1..10", async () => {
  const plan = Array.from({ length: 12 }, (_, i) => TODO(`R${i + 1}`)).join("\n");
  const a = fakeRun({ plan });
  assert.equal((await runRefactorBatches(config(ALL, { refactorBatchesPerRun: 2 }), a.deps, { ...a.opts, maxBatches: undefined })).statusSummary, "2 batches applied (R1, R2); batch limit (2) reached");
  const b = fakeRun({ plan });
  assert.equal((await runRefactorBatches(config(ALL), b.deps, { ...b.opts, maxBatches: undefined })).statusSummary, "3 batches applied (R1, R2, R3); batch limit (3) reached");
  const c = fakeRun({ plan });
  assert.equal((await runRefactorBatches(config(ALL), c.deps, { ...c.opts, maxBatches: 50 })).statusSummary, `10 batches applied (${Array.from({ length: 10 }, (_, i) => `R${i + 1}`).join(", ")}); batch limit (10) reached`);
});

test("batch 2 retakes the graph baseline before its batch stages, batch 1 does not", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  await runRefactorBatches(config(ALL), deps, opts);
  assert.deepEqual(state.ran, ["plan", "snap", "write", "apply", "test", "check", "snap", "write", "apply", "test", "check"]);
});

test("a batch that passed but is still todo stops the run instead of applying it again", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  deps.runStage = async (s) => { state.ran.push(s.id); if (s.id === "plan") state.plan = TODO("R1") + "\n" + TODO("R2"); return { ok: true, output: "" }; };
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /R1 is still todo after its run; stopped/);
});

test("splitRefactorPhases keeps a user stage in the phase its position falls in", () => {
  const user = stage("user", { name: "Lint", defaultKey: null });
  const { planning, batch } = splitRefactorPhases([PLAN, SNAP, user, WRITE, APPLY, TEST]);
  assert.deepEqual(planning.map((s) => s.id), ["plan", "snap", "user"]);
  assert.deepEqual(batch.map((s) => s.id), ["write", "apply", "test"]);
  const late = stage("late", { name: "Late", defaultKey: null });
  assert.deepEqual(splitRefactorPhases([PLAN, WRITE, late, APPLY]).batch.map((s) => s.id), ["write", "late", "apply"]);
});

const BASELINE = stage("baseline", { name: "Test Baseline", defaultKey: "refactor-test-baseline", allowsRepair: false });

test("a batch whose only outcome is skipped still passes the run", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1"), skipBatches: ["R1"] });
  const out = await runRefactorBatches(config(ALL), deps, opts);
  assert.equal(out.passed, true);
  assert.match(out.statusSummary, /0 batches applied; R1 skipped/);
  assert.deepEqual(state.restores, []);
});

test("a red Test Baseline restores the batch and leaves it todo instead of blocking it", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1"), baselineFails: true });
  const out = await runRefactorBatches(config([PLAN, SNAP, WRITE, BASELINE, APPLY, TEST, CHECK]), deps, opts);
  assert.equal(out.passed, false);
  assert.deepEqual(state.restores, ["tree1"]);
  assert.match(state.plan, /### R1 — R1 \(status: todo\)/);
  assert.doesNotMatch(state.plan, /Blocked:/);
  assert.match(out.statusSummary, /R1 rolled back and left todo: /);
});

test("the cost ceiling is per run: the batch that reaches it is rolled back and left todo", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  const paid = { ...deps, async runStage(s, prior) { const r = await deps.runStage(s, prior); return s.id === "apply" ? { ...r, usage: { costUsd: 3 } } : r; } };
  const out = await runRefactorBatches(config(ALL, { maxCostUsd: 4 }), paid, opts);
  assert.equal(state.ran.filter((id) => id === "apply").length, 2, "R2 started with $1 left and hit the ceiling");
  assert.match(state.plan, /### R1 — R1 \(status: done\)/);
  assert.match(state.plan, /### R2 — R2 \(status: todo\)/, "a budget stop leaves the batch todo, not blocked");
  assert.deepEqual(state.restores, ["tree2"]);
  assert.equal(out.passed, true);
  assert.ok(out.costUsd <= 6);
});

test("a missing plan file after planning fails the run instead of passing it", async () => {
  const { deps, opts } = fakeRun({ plan: TODO("R1") });
  const out = await runRefactorBatches(config(ALL), deps, { ...opts, readPlan: async () => null });
  assert.equal(out.passed, false);
  assert.match(out.statusSummary, /the plan file is missing after planning/);
});

test("a run that kept a batch is a pass even when a later batch errored, without an error status", async () => {
  const { deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  let n = 0;
  const erroring = { ...deps, async runStage(s, prior) { if (s.id === "apply" && ++n === 2) return { ok: false, output: "agent call failed" }; return deps.runStage(s, prior); }, halt: () => (n === 2 ? "agent call failed; the run stopped" : null), haltIsError: () => true };
  const out = await runRefactorBatches(config(ALL), erroring, opts);
  assert.equal(out.passed, true);
  assert.equal(out.errored, undefined);
  assert.match(out.statusSummary, /R2 rolled back and left todo/);
});

test("the pause sits between two batches, before the second batch's checkpoint, and not before the first", async () => {
  const { deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  const events = [];
  const traced = {
    ...deps,
    async runStage(s, prior) { events.push(`run:${s.id}`); return deps.runStage(s, prior); },
    sleep(ms) { events.push(`sleep:${ms}`); return Promise.resolve(); },
  };
  const tracedOpts = { ...opts, async checkpoint() { events.push("checkpoint"); return opts.checkpoint(); } };
  const out = await runRefactorBatches(config(ALL, { stageDelaySeconds: 2 }), traced, tracedOpts);
  assert.equal(out.passed, true);
  const [first, second] = events.reduce((acc, e, i) => (e === "checkpoint" ? [...acc, i] : acc), []);
  assert.equal(events[first - 1], "sleep:2000", "a pause between planning and batch 1");
  assert.equal(events[second - 1], "sleep:2000", "a pause right before batch 2's checkpoint");
});

test("a loop with no enabled Apply runs as one plain loop: plan-only never batches", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") });
  const noApply = config(ALL.map((st) => (st.id === "apply" ? { ...st, enabled: false } : st)));
  const out = await runRefactorBatches(noApply, deps, opts);
  assert.equal(out.passed, true, out.statusSummary);
  assert.equal(state.checkpoints, 0, "no batch checkpoint");
  const planOnly = config([PLAN, SNAP]);
  const out2 = await runRefactorBatches(planOnly, fakeRun({ plan: TODO("R1") }).deps, fakeRun({ plan: TODO("R1") }).opts);
  assert.equal(out2.passed, true, "a planning-only loop no longer throws 'no enabled stages'");
});

test("a host error during a batch rolls the batch back and ends the run as an error with a summary", async () => {
  const { state, deps, opts } = fakeRun({ plan: TODO("R1") + "\n" + TODO("R2") });
  let reads = 0;
  const flaky = { ...opts, async readPlan() { reads += 1; if (reads === 4) throw new Error("disk gone"); return opts.readPlan(); } };
  const out = await runRefactorBatches(config(ALL), deps, flaky);
  assert.equal(out.passed, true, "R1 was verified before the error");
  assert.match(out.statusSummary, /stopped: disk gone/);
  const { deps: d2, opts: o2, state: s2 } = fakeRun({ plan: TODO("R1") });
  const broken = { ...o2, async checkpoint() { throw new Error("git write-tree failed"); } };
  const out2 = await runRefactorBatches(config(ALL), d2, broken);
  assert.equal(out2.passed, false);
  assert.equal(out2.errored, true);
  assert.match(out2.statusSummary, /stopped: git write-tree failed/);
  assert.equal(s2.restores.length, 0, "nothing to roll back before the checkpoint existed");
});
