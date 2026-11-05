import assert from "node:assert/strict";
import test from "node:test";
import { createCustomTask, customTaskRunnable, customTaskStatus, dueCustomTasks, loadCustomTasks, newCustomTaskId, saveCustomTasks, updateCustomTask, validateCustomTask } from "../native/custom.ts";

function storage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), clear: () => map.clear() };
}
const ROOT = "/p/one";

test("custom task: draft validation and Review-only desktop runnable", () => {
  assert.equal(validateCustomTask({ name: "", prompt: "x", mode: "review", cron: "" }), "Give the task a name.");
  assert.equal(validateCustomTask({ name: "x", prompt: "", mode: "review", cron: "" }), "Write the prompt the task should run.");
  assert.match(validateCustomTask({ name: "x", prompt: "p", mode: "review", cron: "0 * * *" }), /five-field/);
  assert.equal(validateCustomTask({ name: "x", prompt: "p", mode: "review", cron: "0 * * * *" }), null);
  assert.equal(customTaskRunnable({ mode: "review" }), true);
  assert.equal(customTaskRunnable({ mode: "implement" }), false);
  assert.match(customTaskStatus({ mode: "implement", cron: "", enabled: true }, true, new Date()), /Mac app only/);
});

test("custom task: create, update, enable and per-project isolation", () => {
  const s = storage();
  const one = createCustomTask(ROOT, { name: " Nightly ", prompt: " Check the build ", mode: "review", cron: "0 2 * * *" }, "custom-one", new Date("2026-11-05T00:00:00Z"));
  assert.equal(one.name, "Nightly");
  assert.equal(one.prompt, "Check the build");
  saveCustomTasks([one], s);
  assert.equal(loadCustomTasks(ROOT, s).length, 1);
  assert.equal(loadCustomTasks("/p/two", s).length, 0, "another project never sees it");
  const two = createCustomTask("/p/two", { name: "Other", prompt: "p", mode: "review", cron: "" }, "custom-two", new Date("2026-11-05T00:00:00Z"));
  saveCustomTasks([two], s);
  assert.equal(loadCustomTasks(ROOT, s).length, 1);
  assert.equal(loadCustomTasks("/p/two", s).length, 1);
  const updated = updateCustomTask(one, { enabled: false, name: "Nightly 2" });
  saveCustomTasks([updated], s);
  assert.deepEqual(loadCustomTasks(ROOT, s).map((t) => [t.name, t.enabled]), [["Nightly 2", false]]);
  saveCustomTasks([], s, ROOT);
  assert.equal(loadCustomTasks(ROOT, s).length, 0, "deleting removes only this project's rows");
  assert.equal(loadCustomTasks("/p/two", s).length, 1);
});

test("custom task: corrupt storage fails closed", () => {
  const s = storage();
  s.setItem("llmide.customAutoTasks.v1", "{not json");
  assert.deepEqual(loadCustomTasks(ROOT, s), []);
  s.setItem("llmide.customAutoTasks.v1", JSON.stringify([{ id: "x", name: "n", prompt: "p", projectRoot: ROOT, mode: "review", cron: "", enabled: true, createdAt: "x" }, null, { id: 1 }]));
  assert.equal(loadCustomTasks(ROOT, s).length, 1);
});

test("custom task: due selection honours master, enabled, cron and the fired minute", () => {
  const at = new Date("2026-11-05T02:00:10");
  const task = (id, over = {}) => ({ id, projectRoot: ROOT, name: id, prompt: "p", mode: "review", cron: "0 * * * *", enabled: true, createdAt: "x", ...over });
  assert.equal(dueCustomTasks([task("a")], false, at).length, 0);
  assert.equal(dueCustomTasks([task("a", { enabled: false })], true, at).length, 0);
  assert.equal(dueCustomTasks([task("a", { cron: "" })], true, at).length, 0);
  assert.equal(dueCustomTasks([task("a")], true, at).length, 1);
  assert.equal(dueCustomTasks([task("a")], true, at, { [`a:2026-11-5-2-0`]: "2026-11-5-2-0" }).length, 0);
  assert.equal(dueCustomTasks([task("a")], true, new Date("2026-11-05T02:01:10")).length, 0);
});

test("custom task: ids are filesystem/ARIA-safe", () => {
  const id = newCustomTaskId("../../bad id!!");
  assert.match(id, /^custom-[A-Za-z0-9_-]+$/);
  assert.ok(id.length <= 55);
});
