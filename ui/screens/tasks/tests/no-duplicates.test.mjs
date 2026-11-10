import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;
// Generated modules and test fixtures legitimately carry prompt text; no other source file may.
const EXCLUDED = (rel) => /\.generated\./.test(rel) || rel.split(sep).includes("fixtures");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name)) out.push(p);
  }
  return out;
}

const promptDir = join(repo, "schema", "tasks", "prompts");
const heads = readdirSync(promptDir)
  .filter((n) => n.endsWith(".md"))
  .map((n) => readFileSync(join(promptDir, n), "utf8").trim().slice(0, 40))
  .filter((h) => h.length === 40);

test("no source file outside schema/tasks/prompts repeats a prompt's first 40 characters", () => {
  const files = [...walk(join(repo, "ui", "screens")), ...walk(join(repo, "extension", "routes"))];
  const hits = [];
  for (const f of files) {
    const rel = relative(repo, f);
    if (EXCLUDED(rel)) continue;
    const text = readFileSync(f, "utf8");
    for (const h of heads) if (text.includes(h)) hits.push(`${rel}: "${h.slice(0, 20)}..."`);
  }
  assert.deepEqual(hits, []);
});

test("AutoTasksScreen.tsx (the dead bridge screen) is gone", () => {
  assert.equal(existsSync(join(repo, "ui", "screens", "autotasks", "AutoTasksScreen.tsx")), false);
});

test("the Auto Tasks screen has no hand-written catalog or Mac-only set", () => {
  const banned = /MAC_ONLY_TASK_IDS|MAC_ONLY_MESSAGE|LOCAL_TASKS|const TASKS: readonly AutoTaskDef\[\]/;
  const offenders = walk(join(repo, "ui", "screens", "autotasks"))
    .filter((f) => banned.test(readFileSync(f, "utf8")))
    .map((f) => relative(repo, f));
  assert.deepEqual(offenders, []);
});
