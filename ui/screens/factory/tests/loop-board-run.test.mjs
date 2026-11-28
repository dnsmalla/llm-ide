import { test } from "node:test";
import assert from "node:assert/strict";
import { WAITING_LANE, afterSend, buildRunEvent, discardTarget, heldState, orderLanes, loopRunCardView, loopRunLanes, loopReadTargets, runBarState, loadHiddenRunIds, loadRunBarInput, saveHiddenRunIds, saveRunBarInput } from "../loop-board-run.ts";
import { ACTION_LABELS, LANE_DONE, LANE_WAITING, stepLane } from "../board-model.ts";

const stage = (over) => ({ id: "s", name: "S", kind: "skill", order: 0, enabled: true, skillId: "skills/refactor-apply", targetPath: null, ...over });
const loop = (stages, over = {}) => ({ id: "L1", inputPath: "src", config: { stages, ...(over.workMode ? { workMode: over.workMode } : {}) } });

test("input path shows only for loops whose skills use it", () => {
  assert.equal(runBarState(loop([stage({})]), { inputPath: "", task: "" }).showInputPath, true);
  const doc = loop([stage({ skillId: "skills/other", targetPath: "llm-doc/plans" })]);
  const st = runBarState(doc, { inputPath: "", task: "" });
  assert.equal(st.showInputPath, false);
  assert.equal(st.reads, "Reads: llm-doc/plans");
  assert.equal(runBarState(loop([stage({ kind: "shell", skillId: null })]), { inputPath: "", task: "" }).reads, "No input file: shell steps only");
});

test("disabled and shell stages do not count as read targets", () => {
  const l = loop([stage({ skillId: "x", targetPath: "a" }), stage({ skillId: "x", targetPath: "b", enabled: false }), stage({ kind: "shell", targetPath: "c", skillId: null }), stage({ skillId: "x", targetPath: "a", order: 3 })]);
  assert.deepEqual(loopReadTargets(l), ["a"]);
});

test("invalid input path and a missing required task block Run", () => {
  assert.match(runBarState(loop([stage({})]), { inputPath: "../x", task: "" }).blocked, /\.\./);
  const one = loop([stage({})], { workMode: "one" });
  assert.match(runBarState(one, { inputPath: "", task: "  " }).blocked, /Required/);
  assert.equal(runBarState(one, { inputPath: "", task: "fix it" }).blocked, null);
  assert.equal(buildRunEvent(one, { inputPath: "", task: "" }), null);
});

test("buildRunEvent normalizes the path, trims the task and omits an unused path", () => {
  assert.deepEqual(buildRunEvent(loop([stage({})]), { inputPath: " ./src\\a/ ", task: "  do x " }), { type: "run-loop", loopId: "L1", inputPath: "src/a", task: "do x" });
  assert.deepEqual(buildRunEvent(loop([stage({})]), { inputPath: "", task: "" }), { type: "run-loop", loopId: "L1", inputPath: "" });
  const noPath = loop([stage({ kind: "shell", skillId: null })]);
  assert.deepEqual(buildRunEvent(noPath, { inputPath: "ignored", task: "" }), { type: "run-loop", loopId: "L1" });
});

test("only the task draft is remembered; the path always comes from the loop", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  saveRunBarInput("Test", { inputPath: "stale", task: "t" }, storage);
  assert.ok(!mem.get("llmide.loopBoardRun.Test").includes("stale"));
  assert.deepEqual(loadRunBarInput({ inputPath: "src" }, "Test", storage), { inputPath: "src", task: "t" });
  assert.deepEqual(loadRunBarInput({ inputPath: "src" }, "None", storage), { inputPath: "src", task: "" });
  const boom = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
  assert.deepEqual(loadRunBarInput({ inputPath: "src" }, "Test", boom), { inputPath: "src", task: "" });
  saveRunBarInput("Test", { inputPath: "", task: "" }, boom);
});

test("hidden run ids are per board name, survive a reload, and a storage failure never throws", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadHiddenRunIds("Test", storage), new Set());
  saveHiddenRunIds("Test", new Set(["r1", "r2"]), storage);
  assert.deepEqual(loadHiddenRunIds("Test", storage), new Set(["r1", "r2"]));
  assert.deepEqual(loadHiddenRunIds("Other", storage), new Set(), "a different board name is unaffected");
  const boom = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
  assert.deepEqual(loadHiddenRunIds("Test", boom), new Set());
  saveHiddenRunIds("Test", new Set(["r1"]), boom);
  assert.deepEqual(loadHiddenRunIds("Test", null), new Set(), "no storage at all");
});

test("discardTarget: the worktree runId comes from the run's own record, never from the journal entry's own id", () => {
  // run.id is a fresh UUID per run; a non-Factory loop's worktree is prepared with the loop's slug instead, so the
  // two never match. The worktree list only carries the slug.
  const run = { id: "entry-uuid-1", loopId: "L1", loopName: "Refactoring", startedAt: "2026-11-27T00:00:00.000Z" };
  const withWorktree = { ok: true, worktree: { runId: "refactoring", branch: "loop/refactoring", baseCommit: "abc", repo: "r" } };
  const info = { runId: "refactoring", project: "/p", repo: "r", worktree: "/p/system/loop-worktrees/refactoring", branch: "loop/refactoring", baseCommit: "abc" };
  const list = (...items) => ({ ok: true, list: items });
  assert.deepEqual(discardTarget(run, withWorktree, list(info), [run], null), { kind: "ok", info });
  // Looking it up by the journal entry's own id (the bug) would find nothing.
  assert.deepEqual(discardTarget(run, withWorktree, list({ ...info, runId: run.id }), [run], null), { kind: "gone" });
  // This run never had a worktree (it worked on the main tree): not the same as "gone" — its edits may still be
  // sitting live there, so the caller must ask before hiding, never fold this into an auto-hide.
  assert.deepEqual(discardTarget(run, { ok: true, worktree: null }, list(info), [run], null), { kind: "no-worktree" });
  // The worktree once existed but was already removed: not in the current list — genuinely gone.
  assert.deepEqual(discardTarget(run, withWorktree, list(), [run], null), { kind: "gone" });
  // The record or the live worktree list could not be read: unknown state, never "gone" or "no-worktree" — those
  // would make the caller hide a card whose real worktree/branch might still be sitting there untouched.
  assert.deepEqual(discardTarget(run, { ok: false }, list(info), [run], null), { kind: "unreadable" });
  assert.deepEqual(discardTarget(run, withWorktree, { ok: false }, [run], null), { kind: "unreadable" });
  // An older run of a loop whose branch a newer run still needs: refused, same rule as the Factory board.
  const newer = { id: "entry-uuid-2", loopId: "L1", startedAt: "2026-11-27T01:00:00.000Z" };
  assert.equal(discardTarget(run, withWorktree, list(info), [run, newer], null).kind, "refused");
  // The loop is running right now: refused even though it is the newest run.
  assert.equal(discardTarget(run, withWorktree, list(info), [run], "L1").kind, "refused");
});

test("the task is whitespace-collapsed in the event", () => {
  assert.equal(buildRunEvent(loop([stage({})]), { inputPath: "", task: " a\n\n b\t c " }).task, "a b c");
});

test("afterSend keeps the path and clears the task", () => {
  assert.deepEqual(afterSend({ inputPath: "src", task: "do x" }), { inputPath: "src", task: "" });
});

test("a held run waits for approval only while it is the loop's newest and unshipped; a leftover-files hold needs the diff", () => {
  const worktree = { runId: "test-1", branch: "loop/test-1", baseCommit: "abc", repo: "/r" };
  const run = { id: "r2", loopId: "L", statusCode: "awaiting_review", startedAt: "2026-11-27T02:00:00Z" };
  const older = { id: "r1", loopId: "L", statusCode: "success", startedAt: "2026-11-27T01:00:00Z" };
  const newer = { id: "r3", loopId: "L", statusCode: "failed", startedAt: "2026-11-27T03:00:00Z" };
  const record = { worktree, mergedMr: "https://gitlab.com/x/-/merge_requests/1", awaiting: { held: "success", kind: "passed", failedStage: null, reason: "human" } };
  assert.deepEqual(heldState(run, record, [older, run]), { kind: "waiting", worktreeRunId: "test-1", mergedMr: "https://gitlab.com/x/-/merge_requests/1" });
  assert.deepEqual(heldState(run, { worktree }, [run]), { kind: "waiting", worktreeRunId: "test-1", mergedMr: null }, "an older record without a reason is a Human hold");
  assert.deepEqual(heldState(run, record, [older, run, newer]), { kind: "superseded" }, "a later run has the shared branch");
  assert.deepEqual(heldState(run, {}, [run]), { kind: "superseded" }, "no worktree left to ship");
  assert.deepEqual(heldState(run, { ...record, awaiting: { ...record.awaiting, reason: "leftoverFiles" } }, [run]), { kind: "reviewDiff" });
  assert.deepEqual(heldState(run, { ...record, ship: { provider: "gitlab", url: "https://gitlab.com/x/-/merge_requests/2", commit: "c" } }, [run]), { kind: "shipped" });
  assert.equal(heldState({ ...run, statusCode: "success" }, record, [run]), null);
  assert.equal(heldState(run, null, [run]), null, "an unreadable record is never offered for approval");
});

test("lanes keep the loop's steps in order, then other lanes, then Waiting for you, then Done last", () => {
  assert.deepEqual(orderLanes(["Plan", "Write"], ["Done", "Write", "Old step", WAITING_LANE]), ["Plan", "Write", "Old step", WAITING_LANE, "Done"]);
  assert.deepEqual(orderLanes([], []), ["Done"]);
  assert.deepEqual(orderLanes(["Plan"], ["Done"]), ["Plan", "Done"]);
});

const NOW = Date.parse("2026-11-27T12:00:00Z");
const entry = (over = {}) => ({ id: "r1", loopId: "L", loopName: "Test", startedAt: "2026-11-27T11:55:00Z", durationSeconds: 42, iterationsUsed: 2, statusCode: "success", statusSummary: "All good.", trigger: "manual", ...over });
const wt = { runId: "test-1", branch: "loop/test", baseCommit: "c0", repo: "r" };
const card = (over, record = null, held = null, steps = ["Plan", "Write"]) => loopRunCardView({ run: entry(over), record, steps, held, now: NOW });

test("a passed run is a Done card with the facts the Factory card shows", () => {
  const v = card({}, { costUsd: 0.5, worktree: wt, diffSummary: { files: ["a", "b"], additions: 3, deletions: 1, truncated: false } });
  assert.equal(v.key, "r1");
  assert.equal(v.title, "Test · 5m ago");
  assert.equal(v.source, "text");
  assert.equal(v.lane, LANE_DONE);
  assert.equal(v.status, "passed");
  assert.equal(v.note, "All good.");
  assert.equal(v.durationSeconds, 42);
  assert.equal(v.costUsd, 0.5);
  assert.equal(v.progressLabel, "2 iterations");
  assert.deepEqual(v.changed, { files: 2, additions: 3, deletions: 1, truncated: false });
  assert.deepEqual(v.actions, ["openLog", "discard"]);
});

test("a failed run sits at the stage that failed, with its loopback and failing stage", () => {
  const record = { worktree: wt, stages: [{ stageName: "Plan", run: { exitCode: 0 } }, { stageName: "Write", run: { exitCode: 1, stdout: "boom" } }, { stageName: "Later", run: { exitCode: 0 } }], loopback: { rounds: 3, maxRounds: 3, reason: "tests", findings: "x fails" } };
  const v = card({ statusCode: "failed", statusSummary: "Verify failed", durationSeconds: 0 }, record);
  assert.equal(v.lane, stepLane("Write"));
  assert.equal(v.status, "failed");
  assert.equal(v.durationSeconds, null);
  assert.equal(v.loopback?.reason, "tests");
  assert.equal(v.failingStage?.name, "Write");
  assert.deepEqual(v.actions, ["openLog", "discard"]);
  assert.equal(card({ statusCode: "failed" }, null).lane, stepLane("Plan"), "no record: the first step");
});

test("held runs: waiting approves, reviewDiff waits without Approve, superseded and shipped are Done", () => {
  const base = { statusCode: "awaiting_review", statusSummary: "Passed. Waiting for your review." };
  const waiting = card(base, { worktree: wt }, { kind: "waiting", worktreeRunId: "test-1", mergedMr: null });
  assert.deepEqual([waiting.lane, waiting.status, waiting.actions], [LANE_WAITING, "awaiting review", ["approve", "openLog", "discard"]]);
  const diff = card(base, { worktree: wt }, { kind: "reviewDiff" });
  assert.deepEqual([diff.lane, diff.status, diff.actions], [LANE_WAITING, "review the diff", ["openLog", "discard"]]);
  const old = card(base, { worktree: wt }, { kind: "superseded" });
  assert.deepEqual([old.lane, old.status], [LANE_DONE, "not shipped"]);
  assert.match(old.note, /^Passed\. Not shipped: a later run/);
  const shipped = card(base, { worktree: wt }, { kind: "shipped" });
  assert.deepEqual([shipped.lane, shipped.status, shipped.note], [LANE_DONE, "shipped", "Passed. Shipped."]);
});

test("the live card sits at its stage with no actions", () => {
  const v = loopRunCardView({ run: entry({ statusCode: "running", statusSummary: "Running now" }), record: null, steps: ["Plan"], held: null, live: { lane: "Write", note: "Writing" }, now: NOW });
  assert.deepEqual([v.lane, v.status, v.note, v.actions], [stepLane("Write"), "running", "Writing", []]);
});

test("loopRunLanes orders steps, other lanes, Waiting for you, then Done, and keeps card order", () => {
  const a = card({ id: "a" });
  const b = card({ id: "b", statusCode: "failed" }, { stages: [{ stageName: "Old step", run: { exitCode: 1 } }] });
  const c = card({ id: "c", statusCode: "awaiting_review" }, { worktree: wt }, { kind: "waiting", worktreeRunId: "test-1", mergedMr: null });
  const d = card({ id: "d" });
  const lanes = loopRunLanes(["Plan", "Write"], [a, b, c, d]);
  assert.deepEqual(lanes.map((l) => [l.id, l.label, l.cards.map((x) => x.key)]), [
    [stepLane("Plan"), "Plan", []], [stepLane("Write"), "Write", []], [stepLane("Old step"), "Old step", ["b"]],
    [LANE_WAITING, WAITING_LANE, ["c"]], [LANE_DONE, "Done", ["a", "d"]],
  ]);
  assert.deepEqual(loopRunLanes([], []).map((l) => l.id), [LANE_DONE]);
  assert.equal(ACTION_LABELS.openLog, "Open run log & plan");
});

test("each Discard confirm carries its own action, so a later check of another card cannot redirect it", async () => {
  const { readFileSync } = await import("node:fs");
  const loopRuns = readFileSync(new URL("../LoopRuns.tsx", import.meta.url), "utf8");
  const cardSrc = readFileSync(new URL("../Card.tsx", import.meta.url), "utf8");
  assert.match(loopRuns, /onConfirm: \(\) => confirmDiscard\(run\.id, worktreeRunId, run\.loopId\)/);
  assert.match(loopRuns, /onConfirm: \(\) => confirmHide\(run\.id\)/);
  assert.equal(/pendingDiscard/.test(loopRuns), false, "no shared ref between cards");
  assert.match(cardSrc, /if \(confirm\) void confirm\(\); else onAction\("discard"\);/);
});

// ---- Done lane ----
import { UNSHIPPED_MESSAGE, doneState, doneStep } from "../loop-board-run.ts";
import { actionsFor } from "../board-model.ts";

const DONE_RUN = { id: "r1", loopId: "L1", loopName: "Refactor", startedAt: "2026-01-01T00:00:00.000Z", durationSeconds: 5, iterationsUsed: 1, statusCode: "success", statusSummary: "Passed.", trigger: "manual" };
const MR_URL = "https://gitlab.com/g/p/-/merge_requests/7";
const withShip = { worktree: { runId: "w1", branch: "b", baseCommit: "c", repo: "" }, ship: { provider: "gitlab", url: MR_URL, commit: "c0ffee", reused: false } };
const st = (state) => ({ url: MR_URL, state, ci: "none", ciSummary: null, comments: [] });
const doneView = (done, checkOnly = false, run = DONE_RUN) => loopRunCardView({ run, record: null, steps: ["A"], held: null, done, checkOnly, now: Date.parse(run.startedAt) });

test("doneState: only finished runs have one", () => {
  assert.equal(doneState({ ...DONE_RUN, statusCode: "failed" }, withShip, null, null), null);
  assert.equal(doneState({ ...DONE_RUN, statusCode: "running" }, null, null, null), null);
  assert.equal(doneState({ ...DONE_RUN, statusCode: "awaiting_review" }, null, { kind: "waiting", worktreeRunId: "w", mergedMr: null }, null), null);
});

test("doneState: MR open / unknown / error keep the card, merged and closed follow the status", () => {
  assert.deepEqual(doneState(DONE_RUN, withShip, null, null), { kind: "mrOpen", url: MR_URL });
  assert.deepEqual(doneState(DONE_RUN, withShip, null, "error"), { kind: "mrOpen", url: MR_URL, statusError: true });
  assert.deepEqual(doneState(DONE_RUN, withShip, null, st("open")), { kind: "mrOpen", url: MR_URL });
  assert.deepEqual(doneState(DONE_RUN, withShip, null, st("merged")), { kind: "mrMerged" });
  assert.deepEqual(doneState(DONE_RUN, withShip, null, st("closed")), { kind: "mrClosed" });
});

test("doneState: no MR in the record is noMr; held shipped or superseded runs are finished", () => {
  assert.deepEqual(doneState(DONE_RUN, { worktree: withShip.worktree, ship: null }, null, null), { kind: "noMr" });
  const held = { ...DONE_RUN, statusCode: "awaiting_review" };
  assert.deepEqual(doneState(held, withShip, { kind: "shipped" }, null), { kind: "mrOpen", url: MR_URL });
  assert.deepEqual(doneState(held, null, { kind: "superseded" }, null), { kind: "noMr" });
});

test("card actions per Done state", () => {
  const open = doneView({ kind: "mrOpen", url: MR_URL });
  assert.deepEqual(open.actions, ["openRequest", "openLog"]);
  assert.deepEqual(open.request, { label: "MR open — shown until merged" });
  const unknown = doneView({ kind: "mrOpen", url: MR_URL, statusError: true });
  assert.deepEqual(unknown.actions, ["done", "openRequest", "openLog"], "an MR whose status cannot be read must not trap the card");
  assert.match(unknown.note, /could not be read/);
  const closed = doneView({ kind: "mrClosed" });
  assert.deepEqual(closed.actions, ["done", "openLog", "discard"]);
  assert.match(closed.note, /closed without merging/);
  assert.deepEqual(doneView({ kind: "noMr" }).actions, ["done", "openLog", "discard"]);
  assert.deepEqual(doneView({ kind: "noMr" }, true).actions, ["done", "openLog"]);
  const oldPlan = loopRunCardView({ run: DONE_RUN, record: { worktree: { runId: "plan-1", branch: "loop/plan-1", baseCommit: "abc", repo: "/r" } }, steps: ["A"], held: null, done: { kind: "noMr" }, checkOnly: true, now: Date.parse(DONE_RUN.startedAt) });
  assert.deepEqual(oldPlan.actions, ["done", "openLog", "discard"], "an old check-only worktree can still be discarded");
  assert.deepEqual(doneView({ kind: "mrMerged" }).actions, ["openLog"]);
  assert.equal(ACTION_LABELS.done, "Done");
});

test("a card with no Done state keeps the old actions", () => {
  assert.deepEqual(doneView(null).actions, ["openLog", "discard"]);
});

test("the Factory board never offers Done", () => {
  for (const column of ["inbox", "needsDecision", "working", "needsYou", "readyToShip", "shipped", "done"]) {
    for (const note of [null, "Interrupted", "Not shipped", "CI failed", "New comments"]) assert.equal(actionsFor(column, note).includes("done"), false, `${column}/${note}`);
  }
});

const okTarget = { kind: "ok", info: { runId: "w1" } };
test("doneStep: unreadable changes nothing; refused, gone and no worktree just hide", () => {
  assert.equal(doneStep({ kind: "unreadable" }, false, null).kind, "error");
  assert.deepEqual(doneStep({ kind: "refused", reason: "older" }, false, null), { kind: "hide" });
  assert.deepEqual(doneStep({ kind: "refused", reason: "older" }, true, null), { kind: "hide" });
  assert.deepEqual(doneStep({ kind: "gone" }, false, null), { kind: "hide" });
  assert.deepEqual(doneStep({ kind: "no-worktree" }, true, null), { kind: "hide" });
});

test("doneStep: a check-only loop's Done only hides the card, with or without a worktree", () => {
  assert.deepEqual(doneStep(okTarget, true, null), { kind: "hide" });
  assert.deepEqual(doneStep(okTarget, true, { changedFiles: 3, localCommits: 1, pushed: false }), { kind: "hide" });
});

test("doneStep: an MR loop's worktree is removed only when nothing is unshipped", () => {
  assert.deepEqual(doneStep(okTarget, false, { changedFiles: 0, localCommits: 0, pushed: true }), { kind: "remove", worktreeRunId: "w1" });
  assert.equal(doneStep(okTarget, false, { changedFiles: 2, localCommits: 0, pushed: false }).kind, "unshipped");
  assert.equal(doneStep(okTarget, false, { changedFiles: 0, localCommits: 1, pushed: false }).kind, "unshipped");
  assert.equal(doneStep(okTarget, false, null).kind, "error");
  assert.match(UNSHIPPED_MESSAGE, /still has unshipped changes: open the run to ship them, or Discard to remove them\.$/);
});

test("a held check-only run offers Done instead of Approve", () => {
  const held = { kind: "waiting", worktreeRunId: "w", mergedMr: null };
  const run = { ...DONE_RUN, statusCode: "awaiting_review" };
  const view = (checkOnly) => loopRunCardView({ run, record: null, steps: ["A"], held, checkOnly });
  assert.deepEqual(view(true).actions, ["done", "openLog", "discard"]);
  assert.deepEqual(view(false).actions, ["approve", "openLog", "discard"]);
});
