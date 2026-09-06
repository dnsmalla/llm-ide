import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symbolFromLine, importFromLine, scanFileByLines } from "../src/code/lineScanner.js";
import { scanCode } from "../src/code/tsScanner.js";
import { mergeCodeAndDoc } from "../src/build/graphMerger.js";

function withTree(files: Record<string, string>, fn: (dir: string) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "gk-line-"));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// Symbol extraction — mirrors the language cases in Swift
// `FileStructureExtractor.symbol(fromLine:language:)`.
// --------------------------------------------------------------------------

test("swift declarations are recognised", () => {
  const cases: Array<[string, string, string]> = [
    ["func go() {}", "go", "function"],
    ["public final class Thing: Base {", "Thing", "class"],
    ["struct Point {", "Point", "struct"],
    ["enum Kind {", "Kind", "enum"],
    ["protocol Drawable {", "Drawable", "protocol"],
    ["extension String {", "String", "extension"],
  ];
  for (const [line, name, kind] of cases) {
    const sym = symbolFromLine(line, "swift");
    assert.equal(sym?.name, name, line);
    assert.equal(sym?.kind, kind, line);
  }
  assert.equal(symbolFromLine("let x = 1", "swift"), null);
});

test("kotlin declarations are recognised", () => {
  assert.equal(symbolFromLine("class Foo {", "kotlin")?.name, "Foo");
  assert.equal(symbolFromLine("fun bar(): Int {", "kotlin")?.kind, "function");
  assert.equal(symbolFromLine("object Singleton {", "kotlin")?.kind, "class");
  assert.equal(symbolFromLine("interface Handler {", "kotlin")?.kind, "interface");
});

test("python declarations are recognised, including async def", () => {
  assert.equal(symbolFromLine("def render(self):", "python")?.name, "render");
  assert.equal(symbolFromLine("async def main():", "python")?.name, "main");
  assert.equal(symbolFromLine("class Widget:", "python")?.kind, "class");
  // Indented (a method) still counts — the Swift AST extractor sees these too.
  assert.equal(symbolFromLine("    def helper(self):", "python")?.name, "helper");
  assert.equal(symbolFromLine("x = 1", "python"), null);
  // A `class` mentioned mid-line is not a declaration.
  assert.equal(symbolFromLine("return self.class_of(x)", "python"), null);
});

test("declaration text stops at the opening brace", () => {
  assert.equal(symbolFromLine("func go(a: Int) -> Int { return a }", "swift")?.declaration,
               "func go(a: Int) -> Int");
});

// --------------------------------------------------------------------------
// Imports
// --------------------------------------------------------------------------

test("imports are extracted per language", () => {
  assert.equal(importFromLine("import Foundation", "swift"), "Foundation");
  assert.equal(importFromLine("import UIKit // comment", "swift"), "UIKit");
  assert.equal(importFromLine("import kotlin.text.Regex", "kotlin"), "kotlin.text.Regex");
  assert.equal(importFromLine("import os", "python"), "os");
  assert.equal(importFromLine("import a.b.c", "python"), "a.b.c");
  assert.equal(importFromLine("from pkg.mod import thing", "python"), "pkg.mod");
  assert.equal(importFromLine("  # import os", "python"), null, "a comment is not an import");
  assert.equal(importFromLine("let importCount = 1", "swift"), null);
});

test("a file yields its symbols and de-duplicated imports", () => {
  return withTree(
    { "a.py": "import os\nimport os\nfrom p.q import r\n\nclass W:\n    def go(self):\n        pass\n" },
    (dir) => {
      const s = scanFileByLines(join(dir, "a.py"))!;
      assert.equal(s.language, "python");
      assert.deepEqual(s.imports, ["os", "p.q"], "duplicate import collapsed");
      assert.deepEqual(s.symbols.map((x) => x.name), ["W", "go"]);
      assert.ok(s.symbols[0]!.line > 0, "line numbers are 1-based and filled in");
    },
  );
});

test("an unreadable or unsupported file yields null rather than throwing", () => {
  return withTree({ "a.txt": "hello" }, (dir) => {
    assert.equal(scanFileByLines(join(dir, "a.txt")), null, "unsupported extension");
    assert.equal(scanFileByLines(join(dir, "missing.py")), null, "missing file");
  });
});

// --------------------------------------------------------------------------
// End to end: the languages reach the graph, and the graph feeds the merge.
//
// This is the regression that mattered — a Swift/Kotlin/Python tree scanned to
// ZERO nodes, so the plugin simply could not see it.
// --------------------------------------------------------------------------

test("swift, kotlin and python files reach the code graph", async () => {
  await withTree(
    {
      "a.swift": "import Foundation\n\nstruct Thing {\n    func go() {}\n}\n",
      "b.kt": "import kotlin.text.Regex\n\nclass Foo {\n  fun bar() {}\n}\n",
      "c.py": "import os\n\nclass Widget:\n    def render(self):\n        pass\n",
    },
    async (dir) => {
      const graph = await scanCode(dir);
      const files = graph.nodes.filter((n) => n.kind === "file").map((n) => n.title).sort();
      assert.deepEqual(files, ["a.swift", "b.kt", "c.py"]);
      for (const name of ["Thing", "go", "Foo", "bar", "Widget", "render"]) {
        assert.ok(graph.nodes.some((n) => n.title === name), `missing symbol ${name}`);
      }
      assert.ok(graph.edges.some((e) => e.kind === "imports"), "imports became edges");
      assert.ok(graph.edges.some((e) => e.kind === "contains"), "symbols hang off their file");
    },
  );
});

test("scanned file nodes carry source_file, so the merge can resolve them", async () => {
  await withTree({ "a.swift": "struct Thing {\n    func go() {}\n}\n" }, async (dir) => {
    const code = await scanCode(dir);
    const fileNode = code.nodes.find((n) => n.kind === "file")!;
    // The merge's module-affinity and path-mention lookups read `source_file`.
    // Emitting only `path` made every such lookup miss — silently, because a
    // missing key is indistinguishable from "this chunk declares no modules".
    assert.equal(fileNode.metadata["source_file"], "a.swift");

    const merged = mergeCodeAndDoc(code, { nodes: [], edges: [], layers: [], tour: [] }, [
      { id: "chunk:1", body: "", wikiLinks: [], relatedModules: ["a.swift"] },
    ]);
    assert.ok(
      merged.edges.some((e) => e.fromId === "chunk:1" && e.kind === "documents"),
      "a declared module must produce a documents edge",
    );
  });
});
