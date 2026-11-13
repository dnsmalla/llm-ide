import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSkillResult } from "../native/step-contract.ts";

const PLAN_TODO = "# Refactor plan\n\n### R1 — remove the legacy module (status: todo)\n- Files: legacy.py\n";
const PLAN_DONE = PLAN_TODO.replace("(status: todo)", "(status: done)");
const PLAN_SKIPPED = PLAN_TODO.replace("(status: todo)", "(status: skipped)");

/** A skill result with every input defaulted; `over` replaces any of them. */
const input = (over = {}) => ({
  skillId: "skills/refactor-planner",
  reply: "Planned: R1",
  changedPaths: [],
  createdPaths: [],
  readPlan: async () => PLAN_TODO,
  exists: async () => true,
  ...over,
});

const ALL_SKILLS = ["skills/refactor-planner", "skills/test-gap-writer", "skills/refactor-apply", "skills/refactor-conform", "skills/test-structure-setup"];
const OTHER_SKILLS = ["skills/writing-plans", "skills/factory-review", "skills/factory-intake", "custom/thing"];

test("a reply-contract skill: an empty or blank reply is refused first, before any other rule", async () => {
  for (const skillId of ALL_SKILLS) {
    for (const reply of ["", "   \n\t"]) {
      const readPlan = async () => { throw new Error("the plan must not be read when the reply is empty"); };
      assert.equal(await checkSkillResult(input({ skillId, reply, readPlan })), "the agent returned no reply", skillId);
    }
  }
});

test("refactor-planner: a missing plan is refused", async () => {
  assert.equal(await checkSkillResult(input({ readPlan: async () => null })), "the plan file was not written");
});

test("refactor-planner: a plan with no batch header is refused", async () => {
  assert.equal(await checkSkillResult(input({ readPlan: async () => "# Refactor plan\n\nNothing to do.\n" })), "the plan has no batch");
});

test("refactor-planner: a heading with a bad status is refused, and the message cuts the heading to 80 characters", async () => {
  const bad = `### R2 — ${"x".repeat(100)} (status: doing)`;
  const plan = `${PLAN_TODO}${bad}\n`;
  assert.equal(await checkSkillResult(input({ readPlan: async () => plan })), `the plan heading "${bad.slice(0, 80)}" has no valid status`);
  const short = "### R2 — add a formatter (status: wip)";
  assert.equal(await checkSkillResult(input({ readPlan: async () => `${PLAN_TODO}${short}\n` })), `the plan heading "${short}" has no valid status`);
});

test("refactor-planner: a plan with valid batches passes, whatever the batches' statuses", async () => {
  for (const plan of [PLAN_TODO, PLAN_DONE, PLAN_SKIPPED, `${PLAN_TODO}### R2 — other (status: blocked)\r\n`]) {
    assert.equal(await checkSkillResult(input({ readPlan: async () => plan })), null);
  }
});

test("test-gap-writer: a reply with no Covered line is refused", async () => {
  assert.equal(await checkSkillResult(input({ skillId: "skills/test-gap-writer", reply: "I wrote some tests." })), "the reply has no 'Covered:' line");
});

test("test-gap-writer: Covered none passes without looking for any file", async () => {
  const exists = async () => { throw new Error("no file must be checked for Covered: none"); };
  assert.equal(await checkSkillResult(input({ skillId: "skills/test-gap-writer", reply: "Covered: none — every function is trivial", exists })), null);
});

test("test-gap-writer: a Covered path that exists passes", async () => {
  const seen = [];
  const exists = async (p) => { seen.push(p); return true; };
  const reply = "Wrote tests.\nCovered: tests/test_tax.py — the JP tax rate";
  assert.equal(await checkSkillResult(input({ skillId: "skills/test-gap-writer", reply, exists })), null);
  assert.deepEqual(seen, ["tests/test_tax.py"]);
});

test("test-gap-writer: a Covered path that does not exist is refused by name", async () => {
  const exists = async (p) => p !== "tests/test_missing.py";
  const reply = "Covered: tests/test_missing.py — the JP tax rate";
  assert.equal(await checkSkillResult(input({ skillId: "skills/test-gap-writer", reply, exists })), "Covered names tests/test_missing.py but that file does not exist");
});

test("refactor-apply: a reply with no Applied line is refused", async () => {
  assert.equal(await checkSkillResult(input({ skillId: "skills/refactor-apply", reply: "Moved the module." })), "the reply has no 'Applied: R<n>' line");
});

test("refactor-apply: Applied R1 while the plan still shows R1 as todo is refused", async () => {
  const r = await checkSkillResult(input({ skillId: "skills/refactor-apply", reply: "Applied: R1", changedPaths: ["legacy.py"] }));
  assert.equal(r, "the plan still shows R1 as todo after Apply");
});

test("refactor-apply: a batch marked done that changed only the plan or system files is refused", async () => {
  const changed = ["llm-doc/loop/refactor/REFACTOR.md", "system/loop/refactor/graph/before.json", ".factory/REVIEW.md", "llm-doc/loop/refactor/NEXT-BATCH.md"];
  const r = await checkSkillResult(input({ skillId: "skills/refactor-apply", reply: "Applied: R1", readPlan: async () => PLAN_DONE, changedPaths: changed }));
  assert.equal(r, "Apply marked R1 done but changed no code");
});

test("refactor-apply: a batch marked done passes once a code path changed, created or deleted", async () => {
  const ok = (over) => checkSkillResult(input({ skillId: "skills/refactor-apply", reply: "Applied: R1", readPlan: async () => PLAN_DONE, ...over }));
  assert.equal(await ok({ changedPaths: ["legacy.py"] }), null, "a deleted code file");
  assert.equal(await ok({ createdPaths: ["fmt.py"] }), null, "a created code file");
  assert.equal(await ok({ changedPaths: ["./src/a.py"] }), null, "a code file under ./");
});

test("refactor-apply: a batch marked skipped with no code change is fine", async () => {
  const r = await checkSkillResult(input({ skillId: "skills/refactor-apply", reply: "Applied: R1", readPlan: async () => PLAN_SKIPPED, changedPaths: [] }));
  assert.equal(r, null);
});

test("refactor-apply: a missing plan after Apply is refused as a missing plan", async () => {
  assert.equal(await checkSkillResult(input({ skillId: "skills/refactor-apply", reply: "Applied: R1", readPlan: async () => null })), "the plan file was not written");
});

test("refactor-conform: a reply with no Conformed line is refused, and one with it passes", async () => {
  assert.equal(await checkSkillResult(input({ skillId: "skills/refactor-conform", reply: "Looked at it." })), "the reply has no 'Conformed: R<n>' line");
  assert.equal(await checkSkillResult(input({ skillId: "skills/refactor-conform", reply: "Conformed: R1 — 0 fixes" })), null);
});

test("an unknown skill (custom, setup, Factory) is judged by the empty-reply rule only", async () => {
  const readPlan = async () => { throw new Error("no plan check for an unknown skill"); };
  const exists = async () => { throw new Error("no path check for an unknown skill"); };
  for (const skillId of ["custom/thing", "skills/writing-plans", "skills/factory-review", "skills/factory-intake"]) {
    assert.equal(await checkSkillResult(input({ skillId, reply: "any words", readPlan, exists })), null, skillId);
  }
});

test("an edited prompt (structured false) gets only the empty-reply rule", async () => {
  const noPlan = input({ readPlan: async () => null, reply: "Planned: R1" });
  assert.equal(await checkSkillResult({ ...noPlan, structured: false }), null);
  assert.equal(await checkSkillResult({ ...noPlan, structured: false, reply: "" }), "the agent returned no reply");
});

test("Factory and custom agents report through files, so an empty reply is not a failure for them", async () => {
  for (const skillId of OTHER_SKILLS) {
    assert.equal(await checkSkillResult(input({ skillId, reply: "", readPlan: async () => null })), null, skillId);
  }
});

test("Covered lines are read leniently: first word only, markdown, commas and ./ are ignored", async () => {
  const seen = [];
  const exists = async (p) => { seen.push(p); return true; };
  const reply = ["Covered: tests/a.py, tests/b.py — two files", "Covered: ./tests/c.py — x", "Covered: **tests/d.py** — bold", "Covered: `tests/e.py`: ok", "Covered: none — nothing"].join("\n");
  assert.equal(await checkSkillResult(input({ skillId: "skills/test-gap-writer", reply, exists })), null);
  assert.deepEqual(seen, ["tests/a.py", "tests/c.py", "tests/d.py", "tests/e.py"]);
});

test("underscores inside a path are kept; only emphasis underscores around it are dropped", async () => {
  const seen = [];
  const exists = async (p) => { seen.push(p); return true; };
  const reply = ["Covered: tests/test_tax.py — a", "Covered: __tests/test_x.py__ — emphasis", "Covered: src/__init__.py — init"].join("\n");
  assert.equal(await checkSkillResult(input({ skillId: "skills/test-gap-writer", reply, exists })), null);
  assert.deepEqual(seen, ["tests/test_tax.py", "tests/test_x.py", "src/__init__.py"]);
});

// Input path: the planner's batch files and the Apply/Conform outside changes, judged only when a folder is set.
const SCOPED_PLAN = "# Refactor plan\n\n### R1 — move billing (status: todo)\n- Files: `src/billing/a.py`, src/billing/b.py\n### R2 — tidy (status: todo)\n- Files: `legacy.py`, src/billing2/c.py\n";

test("refactor-planner in a scoped Loop: a batch file outside the input path is refused by batch and file", async () => {
  const r = await checkSkillResult(input({ readPlan: async () => SCOPED_PLAN, inputPath: "src/billing" }));
  assert.equal(r, "batch R2 lists legacy.py, which is outside the input path src/billing");
  assert.equal(await checkSkillResult(input({ readPlan: async () => SCOPED_PLAN.replace("legacy.py", "src/billing/d.py").replace("src/billing2/c.py", "src/billing/c.py"), inputPath: "src/billing" })), null);
  assert.equal(await checkSkillResult(input({ readPlan: async () => SCOPED_PLAN.replace("`legacy.py`, src/billing2/c.py", "src/billing2/c.py"), inputPath: "src/billing" })), "batch R2 lists src/billing2/c.py, which is outside the input path src/billing", "a sibling folder is not inside");
});

test("refactor-planner in a scoped Loop: a Files entry of none or an empty list is ignored, and ./ is the same path", async () => {
  const plan = "# Plan\n\n### R1 — nothing (status: todo)\n- Files: none\n### R2 — move (status: todo)\n- Files: ./src/billing/a.py\n";
  assert.equal(await checkSkillResult(input({ readPlan: async () => plan, inputPath: "src/billing" })), null);
});

test("refactor-planner with an empty or missing input path has no new rule", async () => {
  for (const inputPath of ["", undefined]) {
    assert.equal(await checkSkillResult(input({ readPlan: async () => SCOPED_PLAN, inputPath })), null, String(inputPath));
  }
});

test("refactor-planner: the scope rule also holds for an edited prompt", async () => {
  assert.equal(await checkSkillResult(input({ readPlan: async () => SCOPED_PLAN, inputPath: "src/billing", structured: false })), "batch R2 lists legacy.py, which is outside the input path src/billing");
});

test("refactor-apply in a scoped Loop: an outside change that is more than an import update is refused by path", async () => {
  const apply = input({ skillId: "skills/refactor-apply", reply: "Applied: R1", readPlan: async () => PLAN_DONE, changedPaths: ["legacy.py"], inputPath: "src/billing", outside: [{ path: "src/other/x.py", importOnly: false }] });
  assert.equal(await checkSkillResult(apply), "Apply changed src/other/x.py, which is outside the input path src/billing and is more than an import update");
  assert.equal(await checkSkillResult({ ...apply, outside: [{ path: "tests/test_x.py", importOnly: true }] }), null, "an import-only outside change passes");
  assert.equal(await checkSkillResult({ ...apply, outside: [{ path: "src/other/x.py", importOnly: false }], inputPath: "" }), null, "no scope rule with an empty input path");
});

test("refactor-conform in a scoped Loop: an outside change that is more than an import update is refused, all import-only passes", async () => {
  const conform = input({ skillId: "skills/refactor-conform", reply: "Conformed: R1 — 1 fix", inputPath: "src/billing" });
  assert.equal(await checkSkillResult({ ...conform, outside: [{ path: "src/other/x.py", importOnly: false }, { path: "tests/test_x.py", importOnly: true }] }), "Conform changed src/other/x.py, which is outside the input path src/billing and is more than an import update");
  assert.equal(await checkSkillResult({ ...conform, outside: [{ path: "tests/test_x.py", importOnly: true }] }), null);
});

test("plan Files lines are read the way a real planner writes them", async () => {
  const { planFiles } = await import("../native/step-contract.ts");
  assert.deepEqual(planFiles("`shop.py`, `tax.py` (new)"), ["shop.py", "tax.py"]);
  assert.deepEqual(planFiles("`src/a.py` (moved from `src/b.py`), ./src/c.py; none"), ["src/a.py", "src/c.py"]);
  assert.deepEqual(planFiles("**utils.py**, `shop.py`."), ["utils.py", "shop.py"], "markdown and a sentence-ending period are dropped");
  const scoped = input({ inputPath: "src", readPlan: async () => "### R1 Move (status: todo)\n- Files: `src/tax.py` (new), `src/shop.py`\n" });
  assert.equal(await checkSkillResult(scoped), null, "a (new) note is not a file outside the input path");
});

test("plan Files keep extensionless files and parentheses inside a path", async () => {
  const { planFiles } = await import("../native/step-contract.ts");
  assert.deepEqual(planFiles("`Makefile`, `Dockerfile` (new), `app/(auth)/page.tsx`"), ["Makefile", "Dockerfile", "app/(auth)/page.tsx"]);
  assert.deepEqual(planFiles("`a.py` (moved from b.py)"), ["a.py"]);
});
