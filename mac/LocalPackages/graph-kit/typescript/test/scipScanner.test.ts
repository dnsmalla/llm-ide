import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { CGNode } from "../src/models.js";
import { parseScipJson, loadScipIndex } from "../src/code/scipScanner.js";

// dist/test/scipScanner.test.js → root is two levels up
const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "..", "test", "fixtures", "scip", "sample.scip.json"), "utf8"),
);

test("parseScipJson emits one definition node per symbol with provenance", () => {
  const graph = parseScipJson(fixture);
  const add = graph.nodes.find((n: CGNode) => n.id === "scip-typescript npm src app add()");
  assert.ok(add, "add node exists");
  // scip-typescript does not populate `kind` on symbols — falls back to "symbol".
  assert.equal(add.kind, "symbol");
  assert.equal(add.metadata.source_file, "src/app.ts");
  // Definition identifier range is a realistic 3-element single-line range [3, 9, 12].
  assert.equal(add.metadata.line, "L3");
  // scip-typescript does not populate Document.language either — falls back to "".
  assert.equal(add.metadata.language, "");
  assert.equal(graph.nodes.length, 4);
});

test("parseScipJson falls back to symbol-string title and populates fields an indexer sets", () => {
  const graph = parseScipJson(fixture);
  const container = graph.nodes.find(
    (n: CGNode) => n.id === "scip-python python container Container#",
  );
  assert.ok(container, "Container node exists");
  assert.equal(container.title, "Container");
  assert.equal(container.kind, "classType");
  assert.equal(container.metadata.language, "Python");
  assert.equal(container.metadata.doc, "A container class.");

  // add() has no display_name, so title falls back to parsing the raw symbol string.
  const add = graph.nodes.find((n: CGNode) => n.id === "scip-typescript npm src app add()");
  assert.ok(add);
  assert.equal(add.title, "add()");
});

test("parseScipJson emits a reference edge from enclosing def to the referenced symbol", () => {
  const graph = parseScipJson(fixture);
  const ref = graph.edges.find(
    (e) => e.fromId === "scip-typescript npm src app main()" &&
           e.toId === "scip-typescript npm src app add()",
  );
  assert.ok(ref, "main references add");
  assert.equal(ref.kind, "references");
  assert.equal(ref.confidence, "EXTRACTED");
});

test("parseScipJson attributes a reference to the innermost enclosing scope, not an outer one", () => {
  const graph = parseScipJson(fixture);
  // The reference to add() at line 4 in src/container.py falls inside BOTH
  // Container's enclosing_range ([1,0,10,1]) and Container.run()'s enclosing_range
  // ([3,2,5,3]) — the innermost (method) must win, not the outer class.
  const fromMethod = graph.edges.find(
    (e) => e.fromId === "scip-python python container Container#run()." &&
           e.toId === "scip-typescript npm src app add()",
  );
  const fromClass = graph.edges.find(
    (e) => e.fromId === "scip-python python container Container#" &&
           e.toId === "scip-typescript npm src app add()",
  );
  assert.ok(fromMethod, "reference attributes to the innermost method scope");
  assert.equal(fromMethod.kind, "references");
  assert.equal(fromClass, undefined, "reference must not also attribute to the outer class scope");
});

test("parseScipJson maps relationships to typed edges", () => {
  const graph = parseScipJson({
    documents: [{
      relative_path: "src/impl.ts",
      language: "TypeScript",
      symbols: [
        { symbol: "s Widget", display_name: "Widget", kind: 7, relationships: [] },
        { symbol: "s Button", display_name: "Button", kind: 7,
          relationships: [{ symbol: "s Widget", is_implementation: true }] },
      ],
      occurrences: [
        { symbol: "s Widget", symbol_roles: 1, range: [1, 0, 5, 0] },
        { symbol: "s Button", symbol_roles: 1, range: [7, 0, 10, 0] },
      ],
    }],
  });
  const impl = graph.edges.find((e) => e.fromId === "s Button" && e.toId === "s Widget");
  assert.ok(impl);
  assert.equal(impl.kind, "implements");
  assert.equal(impl.confidence, "EXTRACTED");
});

test("parseScipJson accepts a string-form kind enum (e.g. name-serialized `scip print --json`)", () => {
  const graph = parseScipJson({
    documents: [{
      relative_path: "src/strkind.ts",
      symbols: [
        { symbol: "s Greet", display_name: "greet", kind: "Function", relationships: [] },
      ],
      occurrences: [
        { symbol: "s Greet", symbol_roles: 1, range: [1, 0, 3] },
      ],
    }],
  });
  const greet = graph.nodes.find((n) => n.id === "s Greet");
  assert.ok(greet);
  assert.equal(greet.kind, "function");
});

test("loadScipIndex rejects when the scip binary is unavailable", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await assert.rejects(() => loadScipIndex("ignored.scip"), /scip/);
  } finally {
    process.env.PATH = originalPath;
  }
});
