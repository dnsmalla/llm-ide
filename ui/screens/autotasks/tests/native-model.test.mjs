import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";
import { defaultTaskState, loadTaskState, saveTaskState } from "../../tasks/store.ts";
import { taskFocus } from "../../tasks/model.ts";
import { TASKS as REGISTRY } from "../../tasks/registry.generated.ts";

function mem() { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; }

test("Auto Tasks defaults are complete, off and carry no stored prompt", () => {
  const s = defaultTaskState();
  assert.equal(s.masterEnabled, false);
  assert.equal(Object.keys(s.configs).length, REGISTRY.filter((t) => t.availability.status === "available").length);
  assert.equal(s.configs["review.code"].enabled, false);
  assert.equal(s.configs["review.code"].promptOverride, null);
  assert.match(taskFocus("review.code"), /most recent changes/);
});

test("Auto Tasks state round-trips per project and ignores unknown tasks", () => {
  const storage = mem();
  const s = defaultTaskState();
  s.masterEnabled = true;
  s.configs["review.code"].enabled = true;
  s.configs["review.code"].inputPath = "src";
  s.configs.unknown = { enabled: true };
  saveTaskState("/p/a", s, storage);
  const back = loadTaskState("/p/a", storage);
  assert.equal(back.masterEnabled, true);
  assert.equal(back.configs["review.code"].enabled, true);
  assert.equal(back.configs["review.code"].inputPath, "src");
  assert.equal(back.configs.unknown, undefined);
  assert.equal(loadTaskState("/p/b", storage).masterEnabled, false, "another project keeps its own state");
});

test("a migrated legacy schedule starts switched off; a schedule saved in the project store stays armed", () => {
  const storage = mem();
  storage.setItem("llmide.autoTasks.v1", JSON.stringify({
    masterEnabled: true,
    configs: {
      regression: { enabled: true, scheduleActive: true, cron: "0 9 * * *" },
      sourceUpdate: { enabled: true, scheduleActive: true, cron: "0 9 * * *" },
    },
  }));
  const s = loadTaskState("/p/a", storage);
  assert.equal(s.configs["loop.regression"].scheduleActive, false);
  assert.equal(s.configs["sources.update"].scheduleActive, false);
  const armed = loadTaskState("/p/a", storage);
  armed.configs["sources.update"] = { ...armed.configs["sources.update"], scheduleActive: true };
  saveTaskState("/p/a", armed, storage);
  assert.equal(loadTaskState("/p/a", storage).configs["sources.update"].scheduleActive, true);
});

test("a registry task's unavailable reason is shown, not the Mac-app copy", () => {
  const env = { features: null, coreFeatures: null, hasRepo: false, localHost: true, mode: "local" };
  assert.match(m.taskUnavailableReason("regression", env), /linked repository/i);
  assert.equal(m.taskUnavailableReason("sourceUpdate", env), null, "Source Update needs no repo");
  assert.match(m.taskUnavailableReason("issues.from_notes", env), /linked repository/i, "the registry reason, not the Mac copy");
  assert.match(m.taskUnavailableReason("reviewMerge", env), /linked repository/i, "Review & Merge is a registry task: its reason, not the Mac copy");
});
