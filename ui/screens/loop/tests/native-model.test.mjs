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
  const skill = m.decodeProjectStore({ loops: [{ name: "S", config: { stages: [{ name: "x", kind: "skill", skillId: "skills/refactor-apply", enabled: true, order: 0 }] } }] }).loops[0];
  assert.equal(s.isManualOnly(skill), true);
  const writer = m.decodeProjectStore({ loops: [{ name: "W", config: { stages: [{ name: "x", kind: "skill", skillId: "skills/test-gap-writer", enabled: true, order: 0 }] } }] }).loops[0];
  assert.equal(s.isManualOnly(writer), false);
});

function fakeFs(contents, hash = "h1") {
  const calls = [];
  return {
    calls,
    async read(path) { if (contents === null) throw Object.assign(new Error("missing"), { code: "missing" }); return { path, status: "ok", size: contents.length, mtime_ms: 0, hash, text: contents, encoding: "utf-8", bom: false, eol: "lf", read_only: false }; },
    async write(path, text, opts) { calls.push({ path, text, opts }); return { path, size: text.length, mtime_ms: 0, hash: "h2" }; },
  };
}

test("store reads current loop.json and writes with the read hash", async () => {
  const fs = fakeFs(JSON.stringify({ schemaVersion: 2, loops: [{ name: "L", config: { stages: [] } }] }));
  const loaded = await s.loadLoops(fs);
  assert.equal(loaded.kind, "ok");
  const saved = await s.saveLoops(fs, loaded.store, loaded.hash);
  assert.equal(saved.hash, "h2");
  assert.equal(fs.calls[0].opts.expected_hash, "h1");
  assert.match(fs.calls[0].text, /"schemaVersion": 2/);
});

test("store distinguishes missing from corrupt and never overwrites silently", async () => {
  assert.equal((await s.loadLoops(fakeFs(null))).kind, "missing");
  assert.equal((await s.loadLoops(fakeFs("{not json"))).kind, "corrupt");
  assert.equal((await s.loadLoops(fakeFs(JSON.stringify({ nope: true })))).kind, "corrupt");
});

test("isNativeRunnable is the single list of kinds the native runner executes", () => {
  for (const kind of ["shellCommand", "regressionSweep", "skill", "artifactCheck", "codeGraph", "testPrune"]) assert.equal(m.isNativeRunnable({ kind, testOp: null }), true, kind);
  for (const testOp of ["structure", "map", "ledger"]) assert.equal(m.isNativeRunnable({ kind: "testMap", testOp }), true, testOp);
  assert.equal(m.isNativeRunnable({ kind: "testMap", testOp: null }), false);
  for (const kind of ["incidentTriage", "sdkSurfaceDiff", "unsupported"]) assert.equal(m.isNativeRunnable({ kind, testOp: null }), false, kind);
});

test("runOnce defaults to false and round-trips when true", () => {
  const store = m.decodeProjectStore({ schemaVersion: 2, loops: [{ id: "l", name: "F", config: { stages: [
    { id: "a", name: "Plain", kind: "shellCommand", order: 0 },
    { id: "b", name: "Once", kind: "skill", order: 1, runOnce: true },
    { id: "c", name: "Junk", kind: "shellCommand", order: 2, runOnce: "yes" },
  ] } }] });
  const [plain, once, junk] = store.loops[0].config.stages;
  assert.equal(plain.runOnce, false);
  assert.equal(once.runOnce, true);
  assert.equal(junk.runOnce, false, "a non-boolean decodes as false");
  const encoded = JSON.parse(m.encodeProjectStore(store)).loops[0].config.stages;
  assert.equal(encoded[1].runOnce, true);
  assert.equal("runOnce" in encoded[0], false, "false is not written");
  assert.equal("runOnce" in encoded[2], false, "false is not written");
});

test("verdict check survives a decode/encode round trip", () => {
  const check = { verdict: { path: ".factory/READINESS.md", line: "Verdict: ready" } };
  const store = m.decodeProjectStore({ schemaVersion: 2, loops: [{ id: "l", name: "F", config: { stages: [{ id: "g", name: "Intake gate", kind: "artifactCheck", order: 0, check }] } }] });
  const again = m.decodeProjectStore(JSON.parse(m.encodeProjectStore(store)));
  assert.deepEqual(again.loops[0].config.stages[0].check, check);
});
