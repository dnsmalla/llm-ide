import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSend, buildRunEvent, discardTarget, loopReadTargets, runBarState, loadHiddenRunIds, loadRunBarInput, saveHiddenRunIds, saveRunBarInput } from "../loop-board-run.ts";

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
