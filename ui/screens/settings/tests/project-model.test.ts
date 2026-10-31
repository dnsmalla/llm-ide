import { test } from "node:test";
import assert from "node:assert/strict";
import { PATHS_TEXT, bytesLabel, decodeMemory, decodePaths, folderNote, projectError, safeRelativePath, syncProviderFor } from "../project-model.ts";

test("safeRelativePath: project-relative only (no absolute, drive, .., controls)", () => {
  assert.equal(safeRelativePath("system/graph/graph.json"), "system/graph/graph.json");
  assert.equal(safeRelativePath("llm-doc/plans"), "llm-doc/plans");
  for (const bad of ["/etc/passwd", "C:\\x", "a/../b", "../x", "", "a\u0000b", "x".repeat(4097), 3, null]) {
    assert.equal(safeRelativePath(bad as unknown), null, String(bad));
  }
});

test("paths: folders decoded, invalid rows dropped, text cleaned", () => {
  const got = decodePaths({
    root: "/Users/a/proj",
    folders: [
      { name: "system", exists: true },
      { name: "llm-doc/plans", exists: false },
      { name: "/abs", exists: true },
      { name: "x", exists: "yes" },
      null,
    ],
  });
  assert.deepEqual(got, { root: "/Users/a/proj", folders: [{ name: "system", exists: true }, { name: "llm-doc/plans", exists: false }] });
  assert.equal(decodePaths({ root: "/p" }), null);
  assert.equal(decodePaths(null), null);
  const many = decodePaths({ root: "/p", folders: Array.from({ length: 100 }, (_, i) => ({ name: `d${i}`, exists: true })) });
  assert.equal(many?.folders.length, 50);
});

test("memory: graph optional, files validated and bounded, database rows ignored", () => {
  const got = decodeMemory({
    root: "/p",
    graph: { path: "system/graph/graph.json", sizeBytes: 2048 },
    files: [
      { name: "memory.json", path: "system/memory.json", sizeBytes: 3 },
      { name: "x", path: "/abs", sizeBytes: 1 },
      { name: "y", path: "system/y", sizeBytes: -1 },
      { name: "", path: "system/z", sizeBytes: 1 },
    ],
  });
  assert.deepEqual(got?.graph, { path: "system/graph/graph.json", sizeBytes: 2048 });
  assert.deepEqual(got?.files, [{ name: "memory.json", path: "system/memory.json", sizeBytes: 3 }]);
  assert.deepEqual(decodeMemory({ root: "/p", graph: null, files: [] }), { root: "/p", graph: null, files: [] });
  assert.equal(decodeMemory({ graph: {} }), null);
  const badGraph = decodeMemory({ root: "/p", graph: { path: "/abs", sizeBytes: 1 }, files: [] });
  assert.equal(badGraph?.graph, null, "an invalid graph row reads as not generated");
});

test("labels and errors: sizes, and a missing project becomes a sentence", () => {
  assert.equal(bytesLabel(0), "0 B");
  assert.equal(bytesLabel(812), "812 B");
  assert.equal(bytesLabel(12 * 1024), "12 KB");
  assert.equal(bytesLabel(3.4 * 1024 * 1024), "3.4 MB");
  assert.equal(projectError("no project is open"), PATHS_TEXT.noProject);
  assert.equal(projectError({ code: "no_project" }), PATHS_TEXT.noProject);
  assert.equal(projectError("boom"), "boom");
  assert.equal(projectError("x".repeat(500)).length, 200);
  assert.equal(projectError({}), "The project folders could not be read.");
});

test("the notes folder sync badge recognises the Mac's four providers", () => {
  assert.match(syncProviderFor("/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Notes")!, /iCloud/);
  assert.match(syncProviderFor("/Users/x/Dropbox/Notes")!, /Dropbox/);
  assert.match(syncProviderFor("/Users/x/Library/CloudStorage/GoogleDrive-a/Notes")!, /Google Drive/);
  assert.match(syncProviderFor("/Users/x/Library/CloudStorage/OneDrive-a/Notes")!, /OneDrive/);
  assert.equal(syncProviderFor("/Users/x/notes"), null);
});

test("canonical folders carry the Mac Paths explanations", () => {
  assert.equal(folderNote("code"), "Code files");
  assert.equal(folderNote("source"), "Meeting & email transcripts");
  assert.match(folderNote("llm-doc/plans")!, /KB plans/);
  assert.equal(folderNote("nope"), null);
});
