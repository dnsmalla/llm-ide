import { test } from "node:test";
import assert from "node:assert/strict";
import * as m from "../native/model.ts";
import * as s from "../native/store.ts";

test("loop.json decodes the current schema with tolerant stage defaults", () => {
  const store = m.decodeProjectStore({ schemaVersion: 2, loops: [{ id: "l", name: "Regression", isPrimary: true, runsOnSchedule: true, config: { stages: [{ name: "Test", kind: "shellCommand", order: 1, command: "npm test" }] } }] });
  assert.equal(store.loops.length, 1);
  assert.equal(store.loops[0].config.stages[0].enabled, true);
  assert.equal(store.loops[0].config.stages[0].severity, "blocking");
  assert.equal(store.loops[0].config.maxIterations, 10);
});

test("legacy bare config becomes one Primary Main Loop and unknown stages survive", () => {
  const store = m.decodeProjectStore({ stages: [{ name: "Custom", kind: "future-thing", order: 0 }] });
  assert.equal(store.loops[0].name, "Main Loop");
  assert.equal(store.loops[0].isPrimary, true);
  assert.equal(store.loops[0].config.stages[0].kind, "unsupported");
  const encoded = JSON.parse(m.encodeProjectStore(store));
  assert.equal(encoded.loops[0].config.stages[0].kind, "future-thing");
});

test("primary/manual-only helpers follow the Mac rules", () => {
  const store = m.decodeProjectStore({ loops: [{ name: "A", isPrimary: false, config: { stages: [] } }, { name: "B", isPrimary: true, config: { stages: [] } }] });
  assert.equal(s.primaryLoop(store).name, "B");
  const refactor = m.decodeProjectStore({ loops: [{ name: "R", defaultKey: "refactor", config: { stages: [] } }] }).loops[0];
  assert.equal(s.isManualOnly(refactor), true);
  const skill = m.decodeProjectStore({ loops: [{ name: "S", config: { stages: [{ name: "x", kind: "skill", enabled: true, order: 0 }] } }] }).loops[0];
  assert.equal(s.isManualOnly(skill), true);
});
