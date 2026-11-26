import { test } from "node:test";
import assert from "node:assert/strict";
import { afterSend, buildRunEvent, loopReadTargets, runBarState, loadRunBarInput, saveRunBarInput } from "../loop-board-run.ts";

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

test("the task is whitespace-collapsed in the event", () => {
  assert.equal(buildRunEvent(loop([stage({})]), { inputPath: "", task: " a\n\n b\t c " }).task, "a b c");
});

test("afterSend keeps the path and clears the task", () => {
  assert.deepEqual(afterSend({ inputPath: "src", task: "do x" }), { inputPath: "src", task: "" });
});
