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
  assert.deepEqual(withTest.loops.map((l) => l.name), ["Regression", "Test", "Plan", "Main Loop", "Refactoring", "Doc Optimization"]);
  assert.equal(withTest.loops[0].isPrimary, true);
  assert.equal(withTest.loops[0].config.stages[1].command, "npm test");
  const noTest = t.initialProjectStore(null);
  assert.equal(noTest.loops.length, 6);
  assert.deepEqual(noTest.loops[0].config.stages.map((s) => s.kind), ["regressionSweep"]);
  assert.ok(noTest.loops.find((l) => l.name === "Plan").config.stages.some((s) => s.kind === "skill"));
});
