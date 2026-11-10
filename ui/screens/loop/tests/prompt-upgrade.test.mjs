import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeProjectStore, encodeProjectStore } from "../native/model.ts";
import { sha256Hex } from "../../chat/approvals/digest.ts";
import { taskPrompt } from "../../tasks/model.ts";
import { initialProjectStore, ensureDefaultLoops } from "../native/templates.ts";
import { detachedFields, promptRefOf, registrySource, shownStagePrompt, stagePromptText, upgradeDefaultStage } from "../native/default-stage.ts";

const OLD = "Old built-in prompt for the doc writer.";
const NEW = "New built-in prompt for the doc writer, revision two.";
const source = (over = {}) => ({ id: "loop.doc_writer", revision: 2, text: NEW, knownPromptHashes: [sha256Hex(OLD)], ...over });
const stage = (over = {}) => ({
  id: "s1", name: "Write docs", kind: "skill", command: null, order: 0, skillId: "skills/doc-writer", targetPath: null, outputPath: null,
  prompt: OLD, isDefault: true, enabled: true, defaultKey: "doc-writer", severity: "blocking", timeoutSeconds: null, detectedCommand: null,
  check: null, testOp: null, graphOp: null, allowsRepair: true, runOnce: false, defaultRevision: 1, disabledByDetection: null, raw: null,
  promptRef: "loop.doc_writer", promptHash: sha256Hex(OLD), ...over,
});

test("an unedited default stage upgrades to the registry revision", () => {
  const up = upgradeDefaultStage(stage(), source());
  assert.equal(up.prompt, NEW);
  assert.equal(up.promptHash, sha256Hex(NEW));
  assert.equal(up.defaultRevision, 2);
  assert.equal(up.promptRef, "loop.doc_writer");
});

test("a stage saved before hashes existed upgrades when its prompt is a known revision", () => {
  const up = upgradeDefaultStage(stage({ promptHash: null }), source());
  assert.equal(up.prompt, NEW);
  assert.equal(up.defaultRevision, 2);
});

test("a hand-edited prompt never upgrades", () => {
  const edited = stage({ prompt: "My own doc prompt." });
  assert.equal(upgradeDefaultStage(edited, source()), edited, "the stored hash no longer matches");
  const legacyEdited = stage({ prompt: "My own doc prompt.", promptHash: null });
  assert.equal(upgradeDefaultStage(legacyEdited, source()), legacyEdited, "no hash and not a known revision");
});

test("a stage at or ahead of the registry revision is left alone", () => {
  const current = stage({ defaultRevision: 2 });
  assert.equal(upgradeDefaultStage(current, source()), current);
});

test("a stage with promptRef runs the registry text even when its inline prompt is an older copy", () => {
  const older = stage({ prompt: OLD, promptHash: sha256Hex(OLD) });
  assert.equal(stagePromptText(older, source()), NEW);
});

test("a detached stage (its first edit) keeps its own text and is never relinked", () => {
  const detached = stage({ ...detachedFields(), prompt: "My own doc prompt." });
  assert.equal(promptRefOf(detached), null);
  assert.equal(registrySource(detached), null);
  assert.equal(stagePromptText(detached, null), "My own doc prompt.");
});

test("a default stage saved before promptRef existed follows the registry through its default key", () => {
  const legacy = stage({ promptRef: null, promptHash: null, defaultKey: "test-write", defaultRevision: 2, prompt: "x" });
  assert.equal(promptRefOf(legacy), "loop.test_gap_writer");
});

test("the rendered prompt of an unedited default stage equals the registry prompt", () => {
  const store = initialProjectStore("npm test");
  const testLoop = store.loops.find((l) => l.defaultKey === "test");
  const writer = testLoop.config.stages.find((s) => s.defaultKey === "test-write");
  assert.equal(promptRefOf(writer), "loop.test_gap_writer");
  assert.equal(shownStagePrompt(writer), taskPrompt("loop.test_gap_writer"));
});

test("a loop.json saved by the build before this change decodes and encodes byte-identically", () => {
  const text = readFileSync(new URL("./fixtures/loop-json-inline.v1.json", import.meta.url), "utf8");
  assert.equal(encodeProjectStore(decodeProjectStore(JSON.parse(text))), text);
});

test("ensureDefaultLoops upgrades an unedited stage that is behind the registry and reports the loop", () => {
  const store = initialProjectStore("npm test");
  const testLoop = store.loops.find((l) => l.defaultKey === "test");
  const writer = testLoop.config.stages.find((s) => s.defaultKey === "test-write");
  // Behind the registry: a stored revision below the task's, with the prompt it was saved with.
  writer.defaultRevision = 0;
  writer.promptHash = sha256Hex(writer.prompt ?? "");
  const out = ensureDefaultLoops(store, "npm test");
  assert.deepEqual(out.upgraded, [testLoop.name]);
  const after = out.store.loops.find((l) => l.defaultKey === "test").config.stages.find((s) => s.defaultKey === "test-write");
  assert.equal(after.defaultRevision, registrySource(after).revision);
  assert.equal(after.prompt, taskPrompt("loop.test_gap_writer"));
});
