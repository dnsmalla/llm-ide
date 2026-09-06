import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCodeAndDoc, normalizeModulePrefix, type MergeChunk } from "../src/build/graphMerger.js";
import { inlineCodeSpans } from "../src/text/docCodeLinker.js";
import type { CGData, CGNode } from "../src/models.js";

function file(path: string): CGNode {
  return {
    id: `file:${path}`,
    title: path.split("/").pop()!,
    kind: "file",
    metadata: { source_file: path },
  };
}

function codeGraph(paths: string[], extra: CGNode[] = []): CGData {
  return { nodes: [...paths.map(file), ...extra], edges: [], layers: [], tour: [] };
}

const emptyDoc: CGData = { nodes: [], edges: [], layers: [], tour: [] };

function chunk(over: Partial<MergeChunk> & { id: string }): MergeChunk {
  return { body: "", wikiLinks: [], relatedModules: [], ...over };
}

const crossLinks = (g: CGData, kind: string) =>
  g.edges.filter((e) => e.kind === kind && e.fromId.startsWith("chunk:"));

// --------------------------------------------------------------------------
// normalizeModulePrefix — authoring forms
//
// Before normalisation everything but `kb` and `kb/` produced zero edges, which
// is the silent-zero failure this feature exists to close.
// --------------------------------------------------------------------------

test("normalizeModulePrefix accepts the natural authoring forms", () => {
  for (const form of ["kb", "kb/", "./kb", "kb/*", "kb/**", "  KB  ", "/kb/"]) {
    assert.equal(normalizeModulePrefix(form), "kb", `form: ${JSON.stringify(form)}`);
  }
  assert.equal(normalizeModulePrefix("extension/kb"), "extension/kb");
  assert.equal(normalizeModulePrefix("./extension/kb/**"), "extension/kb");
});

test("normalizeModulePrefix rejects what cannot name a repo path", () => {
  // `..` is rejected because resolving a parent reference against an unknown
  // base is a guess. This is unobservable in merged output — no repo-relative
  // path starts with `..` — so it can only be pinned here.
  for (const form of ["", "   ", ".", "..", "../kb", "kb/../etc", "/", "//"]) {
    assert.equal(normalizeModulePrefix(form), null, `form: ${JSON.stringify(form)}`);
  }
});

// --------------------------------------------------------------------------
// Cross-link mechanisms and their caps
// --------------------------------------------------------------------------

test("wikilinks to a code symbol are EXTRACTED references", () => {
  const code = codeGraph(["kb/db.mjs"], [
    { id: "function:kb/db.mjs:backupTo", title: "backupTo", kind: "function",
      metadata: { source_file: "kb/db.mjs" } },
  ]);
  const merged = mergeCodeAndDoc(code, emptyDoc, [
    chunk({ id: "chunk:1", wikiLinks: ["backupTo"] }),
  ]);
  const refs = crossLinks(merged, "references");
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.toId, "function:kb/db.mjs:backupTo");
  assert.equal(refs[0]!.confidence, "EXTRACTED", "author-asserted, not inferred");
});

test("declared modules link to the files under them, capped at 8 (fan-out)", () => {
  // 10 files under `kb`, so the cap is what bounds the result. A directory
  // declaration must not become an unbounded hub.
  const paths = Array.from({ length: 10 }, (_, i) => `kb/f${i}.mjs`);
  const merged = mergeCodeAndDoc(codeGraph(paths), emptyDoc, [
    chunk({ id: "chunk:1", relatedModules: ["kb"] }),
  ]);
  const docs = crossLinks(merged, "documents");
  assert.equal(docs.length, 8);
  assert.ok(docs.every((e) => e.confidence === "EXTRACTED"));
  // Deterministic: paths are sorted, so it is always the first 8.
  assert.deepEqual(
    docs.map((e) => e.toId).sort(),
    paths.slice(0, 8).map((p) => `file:${p}`).sort(),
  );
});

test("a file absorbs at most 32 declaring chunks (fan-in)", () => {
  // Every chunk declaring the same single-file module. Without the fan-in cap
  // that one file absorbs an edge from all 40, which is the hub-domination
  // failure the layout work removed.
  const chunks = Array.from({ length: 40 }, (_, i) =>
    chunk({ id: `chunk:${i}`, relatedModules: ["kb/only.mjs"] }));
  const merged = mergeCodeAndDoc(codeGraph(["kb/only.mjs"]), emptyDoc, chunks);
  assert.equal(crossLinks(merged, "documents").length, 32);
});

test("backtick mentions are INFERRED, and fenced ones do not link", () => {
  const code = codeGraph(["kb/db.mjs", "kb/auth.mjs"]);
  const merged = mergeCodeAndDoc(code, emptyDoc, [
    chunk({
      id: "chunk:1",
      body: "Uses `kb/db.mjs` here.\n\n```\n`kb/auth.mjs` is only quoted\n```\n",
    }),
  ]);
  const refs = crossLinks(merged, "references");
  assert.equal(refs.length, 1, "the fenced mention must not link");
  assert.equal(refs[0]!.toId, "file:kb/db.mjs");
  assert.equal(refs[0]!.confidence, "INFERRED", "a mention is a heuristic");
});

test("a chunk links to a given code node at most once", () => {
  // Wikilink and mention both resolve to the same node; the first wins and the
  // duplicate is dropped rather than drawn twice.
  const merged = mergeCodeAndDoc(codeGraph(["kb/db.mjs"]), emptyDoc, [
    chunk({ id: "chunk:1", wikiLinks: ["db.mjs"], body: "also `kb/db.mjs`" }),
  ]);
  const toDb = merged.edges.filter((e) => e.fromId === "chunk:1" && e.toId === "file:kb/db.mjs");
  assert.equal(toDb.length, 1);
  assert.equal(toDb[0]!.confidence, "EXTRACTED", "the stronger signal wins");
});

test("with no code nodes the merge is a plain union", () => {
  const doc: CGData = {
    nodes: [{ id: "doc:1", title: "D", kind: "memoryDoc", metadata: {} }],
    edges: [], layers: [], tour: [],
  };
  const merged = mergeCodeAndDoc({ nodes: [], edges: [], layers: [], tour: [] }, doc, [
    chunk({ id: "chunk:1", wikiLinks: ["anything"], relatedModules: ["kb"] }),
  ]);
  assert.equal(merged.nodes.length, 1);
  assert.equal(merged.edges.length, 0);
});

test("layers and tour survive the merge", () => {
  const code: CGData = { ...codeGraph(["a.ts"]), layers: [{ id: "L", name: "Layer", nodeIds: [] }] };
  const merged = mergeCodeAndDoc(code, emptyDoc, []);
  assert.equal(merged.layers.length, 1, "every earlier transform dropped these");
});

test("inlineCodeSpans takes identifiers, not prose", () => {
  assert.deepEqual(inlineCodeSpans("use `kb/db.mjs` and `backupTo`"), ["kb/db.mjs", "backupTo"]);
  assert.deepEqual(inlineCodeSpans("`a phrase in backticks`"), [], "whitespace disqualifies");
  assert.deepEqual(inlineCodeSpans("`x`"), [], "1 char is below the 2-char floor");
  assert.deepEqual(inlineCodeSpans("`dup` and `dup`"), ["dup"], "deduped");
});
