import { test } from "node:test";
import assert from "node:assert/strict";
import * as t from "../native/templates.ts";
import * as e from "../native/environment.ts";

test("Loop recipes resolve detected test commands and drop the test stage when none exists", () => {
  const recipe = t.BUILT_IN_TEMPLATES.find((x) => x.id === "test-and-fix");
  const applied = t.applyTemplate(recipe, "npm test");
  assert.deepEqual(applied.stages.map((s) => s.name), ["Regression", "Test"]);
  assert.equal(applied.stages[1].command, "npm test");
  assert.notEqual(applied.stages[0].id, recipe.config.stages[0].id);
  const missing = t.applyTemplate(recipe, null);
  assert.deepEqual(missing.stages.map((s) => s.name), ["Regression"]);
});

test("project environment detection reads manifests without executing anything", async () => {
  const fs = { async read(path) { if (path === "package.json") return { status: "ok", text: '{"scripts":{"test":"vitest"}}' }; throw Object.assign(new Error("missing"), { code: "missing" }); } };
  assert.equal((await e.detectTestCommand(fs)).command, "npm test");
  const swift = { async read(path) { if (path === "Package.swift") return { status: "ok", text: "" }; throw Object.assign(new Error("missing"), { code: "missing" }); } };
  assert.equal((await e.detectTestCommand(swift)).command, "swift test");
  const none = { async read() { throw Object.assign(new Error("missing"), { code: "missing" }); } };
  assert.equal((await e.detectTestCommand(none)).command, null);
});

test("custom Loop templates persist, unique-name and delete", () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const cfg = t.BUILT_IN_TEMPLATES[0].config;
  const a = t.saveCustomTemplate("Test & Fix", "mine", cfg, storage);
  assert.equal(a.name, "Test & Fix 2");
  const b = t.saveCustomTemplate("Mine", "", cfg, storage);
  assert.equal(t.loadCustomTemplates(storage).length, 2);
  t.deleteCustomTemplate(a.id, storage);
  assert.deepEqual(t.loadCustomTemplates(storage).map((x) => x.name), ["Mine"]);
  assert.equal(b.name, "Mine");
});

test("missing Loop config seeds the Mac starter loops with the detected test command", () => {
  const withTest = t.initialProjectStore("npm test");
  assert.deepEqual(withTest.loops.map((l) => l.name), ["Regression", "Test", "Plan", "Main Loop", "Refactoring", "Doc Optimization", "Factory"]);
  assert.equal(withTest.loops[0].isPrimary, true);
  assert.equal(withTest.loops[0].config.stages[1].command, "npm test");
  const noTest = t.initialProjectStore(null);
  assert.equal(noTest.loops.length, 7);
  assert.deepEqual(noTest.loops[0].config.stages.map((s) => s.kind), ["regressionSweep"]);
  assert.ok(noTest.loops.find((l) => l.name === "Plan").config.stages.some((s) => s.kind === "skill"));
});

test("the Mac loop recipes are available as templates", () => {
  for (const id of ["plan-director", "refactoring", "doc-optimization", "test-growth"]) {
    const t0 = t.BUILT_IN_TEMPLATES.find((x) => x.id === id);
    assert.ok(t0, `${id} missing`);
    assert.ok(t0.config.stages.length > 0, `${id} has no stages`);
  }
});

test("all twelve Mac built-in recipes are present", () => {
  const names = t.BUILT_IN_TEMPLATES.map((x) => x.name);
  for (const n of ["Test & Fix", "Full Verify", "Regression", "Test", "Skill Loop", "Docs Refresh", "Operation App Diagnosis", "System Check", "Plan Director", "Refactoring", "Doc Optimization", "Test Growth"]) assert.ok(names.includes(n), `${n} missing`);
});

function memStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}

test("an unreadable recipe store is never overwritten: save and delete refuse, the bytes are backed up, nothing is lost", () => {
  const corrupt = "{not json";
  const storage = memStorage({ "llmide.loopTemplates.v1": corrupt });
  const cfg = t.BUILT_IN_TEMPLATES[0].config;
  assert.equal(t.loadCustomTemplatesState(storage).problem, "unreadable");
  assert.throws(() => t.saveCustomTemplate("Mine", "", cfg, storage), /nothing was saved/);
  assert.throws(() => t.deleteCustomTemplate("x", storage), /nothing was saved/);
  assert.equal(storage.map.get("llmide.loopTemplates.v1"), corrupt);
  assert.equal(storage.map.get(t.CUSTOM_BACKUP_KEY), corrupt);
});

test("entries that fail the shape check are kept as a problem, not silently dropped on the next save", () => {
  const good = { id: "a", name: "Kept", summary: "", config: {} };
  const bad = { id: 7, name: "bad", config: {} };
  const storage = memStorage({ "llmide.loopTemplates.v1": JSON.stringify([good, bad]) });
  const state = t.loadCustomTemplatesState(storage);
  assert.equal(state.problem, "incomplete");
  assert.deepEqual(state.templates.map((x) => x.name), ["Kept"]);
  assert.throws(() => t.saveCustomTemplate("New", "", t.BUILT_IN_TEMPLATES[0].config, storage), /nothing was saved/);
  assert.equal(storage.map.get(t.CUSTOM_BACKUP_KEY), JSON.stringify([good, bad]));
});

test("reset keeps a backup and lets saving work again", () => {
  const storage = memStorage({ "llmide.loopTemplates.v1": "{broken" });
  t.resetCustomTemplates(storage);
  assert.equal(t.loadCustomTemplatesState(storage).problem, null);
  assert.equal(storage.map.get(t.CUSTOM_BACKUP_KEY), "{broken");
  t.saveCustomTemplate("Fresh", "", t.BUILT_IN_TEMPLATES[0].config, storage);
  assert.deepEqual(t.loadCustomTemplates(storage).map((x) => x.name), ["Fresh"]);
});

test("a write that does not reach storage throws instead of reading as saved", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem() {} };
  assert.throws(() => t.saveCustomTemplate("Mine", "", t.BUILT_IN_TEMPLATES[0].config, storage), /quota/);
});

test("detectTestCommand reads a run worktree when given a prefix", async () => {
  const prefix = "system/loop-worktrees/run1";
  const fs = { async read(path) { if (path === `${prefix}/Makefile`) return { status: "ok", text: "test:\n\tnpm test\n" }; throw Object.assign(new Error("missing"), { code: "missing" }); } };
  assert.deepEqual(await e.detectTestCommand(fs, prefix), { command: "make test", reason: "Makefile has a test target." });
});

test("detectProjectTestCommand falls back to the first linked clone under code/", async () => {
  const fs = {
    async read(path) {
      if (path === "code/llm-ide/Makefile") return { status: "ok", text: "test:\n\tnpm test\n" };
      throw Object.assign(new Error("missing"), { code: "missing" });
    },
    async list(path) {
      if (path === "code") return { entries: [{ name: "llm-ide", kind: "dir" }, { name: "notes", kind: "file" }] };
      throw Object.assign(new Error("missing"), { code: "missing" });
    },
  };
  assert.deepEqual(await e.detectProjectTestCommand(fs), { command: "make test", reason: "Makefile has a test target.", prefix: "code/llm-ide" });
});
