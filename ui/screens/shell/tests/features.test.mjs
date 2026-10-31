import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_FEATURES,
  FEATURES,
  PRESETS,
  compiledFeatures,
  dependentsOf,
  featuresFromPrefs,
  isSectionEnabled,
  presetFor,
  usableFeatures,
  validateFeatures,
} from "../features.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

test("the feature keys are the Mac's AppFeature set", () => {
  assert.deepEqual(ALL_FEATURES, ["file_explorer", "agent_chat", "code_graph_3d", "gantt_issues", "terminal", "doc_gen", "mobile_sync", "auto_tasks"]);
  assert.equal(FEATURES.find((f) => f.id === "agent_chat").excludable, false, "chat is never excludable");
  assert.ok(FEATURES.filter((f) => f.id !== "agent_chat").every((f) => f.excludable));
});

test("dependency validation drops dependents to a fixed point", () => {
  const noExplorer = validateFeatures(["agent_chat", "code_graph_3d", "gantt_issues", "doc_gen", "terminal"]);
  assert.deepEqual([...noExplorer].sort(), ["agent_chat", "terminal"], "graph/gantt/docgen need File Explorer");
  const all = validateFeatures(ALL_FEATURES);
  assert.equal(all.size, ALL_FEATURES.length);
  assert.deepEqual(dependentsOf("file_explorer").sort(), ["code_graph_3d", "doc_gen", "gantt_issues"]);
});

test("stored prefs: empty means every feature; unknown keys are ignored", () => {
  assert.equal(featuresFromPrefs([]).size, ALL_FEATURES.length);
  assert.equal(featuresFromPrefs(null).size, ALL_FEATURES.length);
  assert.deepEqual([...featuresFromPrefs(["agent_chat", "nonsense", "file_explorer"])].sort(), ["agent_chat", "file_explorer"]);
});

test("presets match the Mac's three, and a hand-picked set is Custom", () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ["full", "focused", "minimal", "custom"]);
  assert.equal(presetFor(PRESETS[0].features), "full");
  assert.equal(presetFor(PRESETS[1].features), "focused");
  assert.equal(presetFor(PRESETS[2].features), "minimal");
  assert.equal(presetFor(["agent_chat", "terminal"]), "custom");
});

test("compiled flags honour dependency closure; usable = active ∩ compiled", () => {
  const compiled = compiledFeatures({ file_explorer: false, code_graph_3d: true, doc_gen: true, agent_chat: true });
  assert.ok(!compiled.has("code_graph_3d") && !compiled.has("doc_gen"), "a compiled graph without Explorer is invalid");
  const active = new Set(ALL_FEATURES);
  const usable = usableFeatures(active, compiled);
  assert.ok(!usable.has("code_graph_3d") && !usable.has("file_explorer") && usable.has("agent_chat"));
  // Undefined flags (tests, dev) mean everything is compiled.
  assert.equal(compiledFeatures().size, ALL_FEATURES.length);
});

test("every toolbar section maps to the Mac's feature, so a feature switch hides it", () => {
  const none = new Set([]);
  for (const id of ["explorer", "graph", "issues", "gantt", "docgen", "visual", "autotasks", "loop"]) {
    assert.equal(isSectionEnabled(id, none), false, `${id} must be feature-gated`);
  }
  for (const id of ["library", "settings", "welcome", "conflicts"]) {
    assert.equal(isSectionEnabled(id, none), true, `${id} is always available`);
  }
  const compiled = compiledFeatures();
  assert.equal(isSectionEnabled("graph", usableFeatures(new Set(["code_graph_3d", "file_explorer"]), compiled)), true);
});

test("the screen loader no longer globs every screen, so a disabled feature's chunk can be dropped", () => {
  const src = readFileSync(join(HERE, "..", "screens.tsx"), "utf8");
  assert.ok(!src.includes("import.meta.glob"), "a static glob would keep every screen in the bundle");
  for (const flag of ["__FEATURE_FILE_EXPLORER__", "__FEATURE_CODE_GRAPH_3D__", "__FEATURE_DOC_GEN__"]) {
    assert.ok(src.includes(flag), `${flag} must guard its loader`);
  }
});
