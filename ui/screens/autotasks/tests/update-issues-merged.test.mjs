import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";

function storageWith(state) {
  const map = new Map(state === undefined ? [] : [["llmide.autoTasks.v1", JSON.stringify(state)]]);
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, String(v)); } };
}

test("a stored Update Issues config maps onto the Sources -> Issue row, schedule off", () => {
  const stored = { masterEnabled: true, configs: { updateIssues: { enabled: true, scheduleActive: true, prompt: "my own prompt", cron: "0 * * * *" } } };
  const state = m.loadState(storageWith(stored));
  assert.equal(state.configs["issues.from_notes"].enabled, true);
  assert.equal(state.configs["issues.from_notes"].scheduleActive, false, "a schedule saved on the old row does not start firing");
  assert.equal(Object.hasOwn(state.configs, "updateIssues"), false);
});

test("the merge notice is shown once, and only for a user who had the old row", () => {
  const withOld = storageWith({ masterEnabled: false, configs: { updateIssues: { enabled: false } } });
  assert.equal(m.takeMergedNotice(withOld), m.UPDATE_ISSUES_MERGED_NOTICE);
  assert.equal(m.takeMergedNotice(withOld), null, "a second look shows nothing");
  assert.equal(m.takeMergedNotice(storageWith({ masterEnabled: false, configs: {} })), null);
  assert.equal(m.takeMergedNotice(storageWith(undefined)), null);
});
