import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeInputPath, pathInside, loopUsesInputPath, INPUT_PATH_SKILLS } from "../native/input-path.ts";

const ok = (raw) => {
  const r = normalizeInputPath(raw);
  assert.ok("path" in r, `expected ${JSON.stringify(raw)} to be accepted, got ${JSON.stringify(r)}`);
  return r.path;
};
const rejected = (raw) => {
  const r = normalizeInputPath(raw);
  assert.ok("error" in r && typeof r.error === "string" && r.error.length > 0, `expected ${JSON.stringify(raw)} to be rejected`);
};

test("empty, dot and slash-dot mean the whole repository", () => {
  assert.equal(ok(""), "");
  assert.equal(ok("   "), "");
  assert.equal(ok("."), "");
  assert.equal(ok("./"), "");
});

test("normalizes separators, leading ./, trailing and doubled slashes", () => {
  assert.equal(ok("src/billing/"), "src/billing");
  assert.equal(ok("./src//billing"), "src/billing");
  assert.equal(ok("src\\billing"), "src/billing");
  assert.equal(ok("  src/billing  "), "src/billing");
});

test("rejects absolute, parent, control and too-long paths", () => {
  for (const raw of ["/etc", "~/x", "C:\\x", "c:/x", "../x", "a/../b", "src/\tbilling", "a".repeat(301)]) rejected(raw);
  assert.equal(ok("a".repeat(300)), "a".repeat(300));
});

test("rejects tool folders and the app's own folders, but only the exact ones", () => {
  for (const raw of [".git/hooks", "node_modules/x", ".factory", "system/graph", "system", "llm-doc/loop/refactor", "llm-doc/loop"]) rejected(raw);
  assert.equal(ok("system-tests"), "system-tests");
  assert.equal(ok("llm-doc/guide"), "llm-doc/guide");
});

test("pathInside is segment-aware and case-sensitive", () => {
  assert.equal(pathInside("", "anything/at/all"), true);
  assert.equal(pathInside("src/billing", "src/billing"), true);
  assert.equal(pathInside("src/billing", "src/billing/invoice.ts"), true);
  assert.equal(pathInside("src/billing", "src/billing2/x.ts"), false);
  assert.equal(pathInside("src/billing", "src/Billing/x.ts"), false);
  assert.equal(pathInside("src/billing", "src"), false);
});

const stage = (skillId, enabled = true) => ({ name: "s", kind: "skill", skillId, enabled });
const loopWith = (...stages) => ({ config: { stages } });

test("INPUT_PATH_SKILLS lists the four file-working skills", () => {
  assert.deepEqual([...INPUT_PATH_SKILLS].sort(), ["skills/refactor-apply", "skills/refactor-conform", "skills/refactor-planner", "skills/test-gap-writer"]);
});

test("loopUsesInputPath follows enabled skill stages", () => {
  assert.equal(loopUsesInputPath(loopWith(stage("skills/refactor-apply"))), true);
  assert.equal(loopUsesInputPath(loopWith(stage("skills/refactor-apply", false))), false);
  assert.equal(loopUsesInputPath(loopWith({ name: "Test", kind: "shellCommand", command: "npm test", enabled: true, skillId: "skills/refactor-apply" })), false);
  assert.equal(loopUsesInputPath(loopWith({ name: "Test", kind: "shellCommand", command: "npm test", enabled: true, skillId: null })), false);
  assert.equal(loopUsesInputPath(loopWith(stage("skills/other"))), false);
});
