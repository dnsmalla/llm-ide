import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";

function mem() { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }; }

test("Auto Tasks defaults are local, complete and off", () => {
  const s = m.defaultState();
  assert.equal(s.masterEnabled, false);
  assert.equal(Object.keys(s.configs).length, m.TASKS.length);
  assert.equal(s.configs.reviewCode.enabled, false);
  assert.match(s.configs.reviewCode.prompt, /READ-ONLY review/);
});

test("Auto Tasks local state round-trips and ignores unknown tasks", () => {
  const storage = mem();
  const s = m.defaultState();
  s.masterEnabled = true;
  s.configs.reviewCode.enabled = true;
  s.configs.reviewCode.inputPath = "src";
  s.configs.unknown = { enabled: true };
  m.saveState(s, storage);
  const back = m.loadState(storage);
  assert.equal(back.masterEnabled, true);
  assert.equal(back.configs.reviewCode.enabled, true);
  assert.equal(back.configs.reviewCode.inputPath, "src");
  assert.equal(back.configs.unknown, undefined);
});

test("a migrated legacy schedule starts switched off, and an explicit new-key schedule stays armed", () => {
  const storage = mem();
  storage.setItem("llmide.autoTasks.v1", JSON.stringify({
    masterEnabled: true,
    configs: {
      regression: { enabled: true, scheduleActive: true, cron: "0 9 * * *" },
      sourceUpdate: { enabled: true, scheduleActive: true, cron: "0 9 * * *" },
      "sources.update": { enabled: true, scheduleActive: true, cron: "0 9 * * *" },
    },
  }));
  const s = m.loadState(storage);
  assert.equal(s.configs["loop.regression"].scheduleActive, false);
  assert.equal(s.configs["sources.update"].scheduleActive, true, "an explicit new-key config is not a migration");
});

test("a registry task's unavailable reason is shown, not the Mac-app copy", () => {
  const env = { features: null, coreFeatures: null, hasRepo: false, localHost: true, mode: "local" };
  assert.match(m.taskUnavailableReason("regression", env), /linked repository/i);
  assert.equal(m.taskUnavailableReason("sourceUpdate", env), null, "Source Update needs no repo");
  assert.equal(m.taskUnavailableReason("sourcesToIssue", env), null, "legacy tasks leave the Mac copy to the screen");
});
