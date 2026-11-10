import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ALIASES, TASKS, TASK_BY_ID } from "../registry.generated.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

test("the checked-in generated copies match schema/tasks", () => {
  assert.doesNotThrow(() => execFileSync("node", ["scripts/gen-task-registry.mjs", "--check"], { cwd: ROOT, stdio: "pipe" }));
});

test("ids and aliases are unique and resolve", () => {
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const [alias, id] of Object.entries(ALIASES)) {
    assert.ok(TASK_BY_ID[id], `${alias} -> ${id}`);
    assert.equal(TASK_BY_ID[id].id, id);
    assert.ok(TASK_BY_ID[id].aliases.includes(alias), alias);
  }
});

test("a retired task has no runner and an agent task has a prompt", () => {
  for (const t of TASKS) {
    if (t.availability.status === "retired" || t.availability.status === "alias") assert.equal(t.runner, null, t.id);
    if (t.runner?.kind === "agent") assert.match(t.runner.prompt, /^prompts\/.+\.md$/, t.id);
    if (t.runner && t.runner.kind !== "agent") assert.equal(t.runner.prompt, undefined, t.id);
  }
});
