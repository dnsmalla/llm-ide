# Fast Deterministic Code Graph (AST + ripgrep) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the code graph instantly from deterministic structure (Python `ast` + ripgrep, app-run, no LLM), then enrich it with LLM notes in the background — replacing the slow graph-derived-from-notes pipeline.

**Architecture:** Two layers. (1) `StructureScanner` extracts files/imports/symbols (Python via a bundled stdlib-`ast` script, others via ripgrep), `ImportResolver` resolves imports to file paths, `StructureGraphBuilder` turns the `ScanResult` straight into `CGData` — rendered immediately. (2) `CodeNoteService` then generates notes concurrently in a detached background task and merges summaries + semantic edges into the published graph.

**Tech Stack:** Swift 5.9+, SwiftUI, Swift Testing, Python 3 (stdlib `ast`, bundled script), ripgrep, the existing `ProcessLauncher`/`CGData`/`ScanResult`/`CodeGraphCanvas`.

**Spec:** `docs/superpowers/specs/2026-06-01-ast-fast-graph-design.md`

---

## File Structure

### New files (`mac/Sources/MeetNotesMac/CodeNotes/`)

| File | Responsibility |
|------|---------------|
| `Resources/code_ast_scan.py` | Bundled stdlib-`ast` analyzer for `.py` (self-contained, zero deps) |
| `RawFileStructure.swift` | Intermediate per-file struct both extractors produce |
| `PythonASTExtractor.swift` | Shell `python3` + bundled script → `[RawFileStructure]` |
| `RipgrepExtractor.swift` | Shell ripgrep/git for non-Python → `[RawFileStructure]`; pure line-parsers |
| `ImportResolver.swift` | Raw import strings → internal file paths (per language) |
| `StructureScanner.swift` | Orchestrate extractors + resolver → `ScanResult` |
| `StructureGraphBuilder.swift` | `ScanResult` → `CGData` (pure) + note-merge enricher |

### Modified

| File | Change |
|------|--------|
| `mac/Package.swift` | Add `Resources/code_ast_scan.py` to target resources |
| `mac/Sources/MeetNotesMac/CodeNotes/CodeNoteService.swift` | New flow: structure→graph→background notes; `@Published var graph`; concurrency |
| `mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift` | Observe `codeNoteService.$graph`; update progress labels |

### Deleted (after unreferenced)

| File | Why |
|------|-----|
| `ScanPhase.swift` + `ScanPhaseTests.swift` | Replaced by `StructureScanner` |
| `EdgeRecovery.swift` + `EdgeRecoveryTests.swift` | Imports now structural; nothing to recover |

### New test files

`PythonASTExtractorTests.swift`, `RipgrepExtractorTests.swift`, `ImportResolverTests.swift`, `StructureGraphBuilderTests.swift`, `StructureScannerTests.swift`

### Environment note (applies to every task)
This Mac has CommandLineTools only (no `xctest`), so `swift test` builds but does NOT execute tests. Use `swift build --build-tests` to confirm everything COMPILES — that is the verification signal. If a build fails with "Invalid manifest" / "Operation not permitted" / temp-dir errors, that's a SANDBOX restriction — retry the same command (the harness runs it unsandboxed). A genuine failure is `error: <file>:<line>`.

---

## Task 1: Bundle the Python AST script + Package.swift resource

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/Resources/code_ast_scan.py`
- Modify: `mac/Package.swift`

- [ ] **Step 1: Create the self-contained Python analyzer**

`mac/Sources/MeetNotesMac/CodeNotes/Resources/code_ast_scan.py`:

```python
#!/usr/bin/env python3
"""Deterministic AST scan for a repo's Python files.

Usage: code_ast_scan.py <repo_root>
Prints JSON to stdout: { "<relpath>": {imports, symbols, loc}, ... }
  imports: [{"module": "<dotted>", "name": "<imported name or null>"}]
  symbols: [{"name": "<n>", "kind": "function|class|method", "line": <int>}]
  loc:     <non-empty line count>
Pure stdlib (ast/json/sys/pathlib). Files that fail to parse are skipped.
"""
import ast
import json
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", ".build", "dist", "build", ".venv",
             "venv", "__pycache__", ".code-notes", ".understand-anything",
             ".mypy_cache", ".pytest_cache", ".ruff_cache"}


def analyze(path: Path):
    try:
        source = path.read_text(errors="replace")
        tree = ast.parse(source, filename=str(path))
    except (SyntaxError, UnicodeDecodeError, ValueError):
        return None

    imports = []
    symbols = []
    for node in ast.iter_child_nodes(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append({"module": alias.name, "name": None})
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            for alias in node.names:
                imports.append({"module": mod, "name": alias.name})
        elif isinstance(node, ast.ClassDef):
            symbols.append({"name": node.name, "kind": "class", "line": node.lineno})
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    symbols.append({"name": node.name + "." + item.name,
                                    "kind": "method", "line": item.lineno})
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append({"name": node.name, "kind": "function", "line": node.lineno})

    loc = sum(1 for line in source.splitlines() if line.strip())
    return {"imports": imports, "symbols": symbols, "loc": loc}


def main():
    if len(sys.argv) < 2:
        print("{}")
        return
    root = Path(sys.argv[1])
    out = {}
    for py in root.rglob("*.py"):
        if any(part in SKIP_DIRS for part in py.parts):
            continue
        result = analyze(py)
        if result is not None:
            out[str(py.relative_to(root))] = result
    print(json.dumps(out))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Register the resource in Package.swift**

In `mac/Package.swift`, the `MeetNotesMac` target already has a `resources:` array with `.copy("Resources/note_template.docx")` and `.copy("Resources/generate_meeting_note.py")`. Add a third entry:

```swift
            resources: [
                .copy("Resources/note_template.docx"),
                .copy("Resources/generate_meeting_note.py"),
                .copy("CodeNotes/Resources/code_ast_scan.py"),
            ],
```

- [ ] **Step 3: Verify the script runs standalone**

Run: `python3 mac/Sources/MeetNotesMac/CodeNotes/Resources/code_ast_scan.py mac/Sources/MeetNotesMac/CodeNotes 2>&1 | head -c 300`
Expected: JSON output (may be `{}` if no `.py` files there — that's fine; just confirm it doesn't error).

- [ ] **Step 4: Build**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/Resources/code_ast_scan.py mac/Package.swift
git commit -m "feat(codenotes): bundle stdlib-ast Python scanner script"
```

---

## Task 2: RawFileStructure intermediate type

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/RawFileStructure.swift`

- [ ] **Step 1: Create the type**

```swift
import Foundation

/// Per-file structural facts produced by an extractor, before import
/// resolution. `rawImports` are unresolved targets (Python dotted modules,
/// or quoted import paths for TS/JS). `StructureScanner` resolves them to
/// internal file paths and assembles the final `ScanResult`.
public struct RawFileStructure: Equatable, Sendable {
    public let path: String          // relative to repo root
    public let language: String      // python | typescript | javascript | swift | other
    public let loc: Int
    public let rawImports: [RawImport]
    public let symbols: [ScanResult.Symbol]

    public init(path: String, language: String, loc: Int,
                rawImports: [RawImport], symbols: [ScanResult.Symbol]) {
        self.path = path
        self.language = language
        self.loc = loc
        self.rawImports = rawImports
        self.symbols = symbols
    }
}

/// An unresolved import. `module` is a dotted path (Python) or a quoted
/// import specifier (TS/JS, e.g. "./foo", "../bar"). `name` is the
/// specifically-imported symbol when known (Python `from a import b`).
public struct RawImport: Equatable, Sendable {
    public let module: String
    public let name: String?
    public init(module: String, name: String? = nil) {
        self.module = module
        self.name = name
    }
}
```

- [ ] **Step 2: Build**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 3: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/RawFileStructure.swift
git commit -m "feat(codenotes): add RawFileStructure + RawImport intermediate types"
```

---

## Task 3: PythonASTExtractor

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/PythonASTExtractor.swift`
- Test: `mac/Tests/MeetNotesMacTests/PythonASTExtractorTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct PythonASTExtractorTests {
    @Test func parsesScriptJSONIntoRawStructures() throws {
        let json = #"""
        {
          "pkg/a.py": {
            "imports": [{"module": "pkg.b", "name": "foo"}, {"module": "os", "name": null}],
            "symbols": [{"name": "run", "kind": "function", "line": 3},
                        {"name": "Service", "kind": "class", "line": 8},
                        {"name": "Service.start", "kind": "method", "line": 9}],
            "loc": 20
          }
        }
        """#.data(using: .utf8)!
        let raws = try PythonASTExtractor.parse(json)
        #expect(raws.count == 1)
        let a = raws.first { $0.path == "pkg/a.py" }!
        #expect(a.language == "python")
        #expect(a.loc == 20)
        #expect(a.rawImports.contains(RawImport(module: "pkg.b", name: "foo")))
        #expect(a.rawImports.contains(RawImport(module: "os", name: nil)))
        #expect(a.symbols.contains(ScanResult.Symbol(name: "run", kind: "function", line: 3)))
        #expect(a.symbols.contains(ScanResult.Symbol(name: "Service.start", kind: "method", line: 9)))
    }

    @Test func emptyJSONYieldsNoStructures() throws {
        let raws = try PythonASTExtractor.parse("{}".data(using: .utf8)!)
        #expect(raws.isEmpty)
    }
}
```

Note: `ScanResult.Symbol` must be `Equatable` (it is — `ScanResult` and its nested types already conform to `Equatable`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift test --filter PythonASTExtractorTests 2>&1 | tail -5` (compiles; won't execute — see env note)
Actually use: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `error:` mentioning `PythonASTExtractor` not found.

- [ ] **Step 3: Implement PythonASTExtractor.swift**

```swift
import Foundation

/// Extracts structure from `.py` files by running the bundled stdlib-`ast`
/// scanner via python3. Pure parsing of the script's JSON is separated out
/// (`parse`) for testability; `run` handles process invocation.
public final class PythonASTExtractor {
    private let launcher: ProcessLauncher
    private let pythonURL: URL?
    private let scriptURL: URL?

    public init(launcher: ProcessLauncher,
                pythonURL: URL? = PythonASTExtractor.resolvePython(),
                scriptURL: URL? = PythonASTExtractor.bundledScriptURL()) {
        self.launcher = launcher
        self.pythonURL = pythonURL
        self.scriptURL = scriptURL
    }

    /// Locate python3 on PATH / common locations. Returns nil if absent.
    public static func resolvePython() -> URL? {
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let cand = URL(fileURLWithPath: String(dir)).appendingPathComponent("python3")
                if FileManager.default.isExecutableFile(atPath: cand.path) { return cand }
            }
        }
        for p in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    /// The bundled scanner script inside the app bundle.
    public static func bundledScriptURL() -> URL? {
        Bundle.main.url(forResource: "code_ast_scan", withExtension: "py")
    }

    /// Run the scanner over `repoRoot`. Returns [] if python3 or the script
    /// is unavailable (Python files still appear via ripgrep enumeration).
    public func run(repoRoot: URL) async -> [RawFileStructure] {
        guard let python = pythonURL, let script = scriptURL else { return [] }
        do {
            let (exit, stdout, _) = try await launcher.run(
                executable: python,
                arguments: [script.path, repoRoot.path],
                currentDirectory: repoRoot,
                environment: nil)
            guard exit == 0 else { return [] }
            return (try? Self.parse(stdout)) ?? []
        } catch {
            return []
        }
    }

    /// Decode the script's JSON into RawFileStructure values.
    public static func parse(_ data: Data) throws -> [RawFileStructure] {
        struct RawSym: Decodable { let name: String; let kind: String; let line: Int }
        struct RawImp: Decodable { let module: String; let name: String? }
        struct RawFile: Decodable { let imports: [RawImp]; let symbols: [RawSym]; let loc: Int }
        let map = try JSONDecoder().decode([String: RawFile].self, from: data)
        return map.map { (path, f) in
            RawFileStructure(
                path: path,
                language: "python",
                loc: f.loc,
                rawImports: f.imports.map { RawImport(module: $0.module, name: $0.name) },
                symbols: f.symbols.map { ScanResult.Symbol(name: $0.name, kind: $0.kind, line: $0.line) })
        }.sorted { $0.path < $1.path }
    }
}
```

- [ ] **Step 4: Build tests**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/PythonASTExtractor.swift mac/Tests/MeetNotesMacTests/PythonASTExtractorTests.swift
git commit -m "feat(codenotes): add PythonASTExtractor (bundled stdlib-ast scanner)"
```

---

## Task 4: RipgrepExtractor

Produces `RawFileStructure` for non-Python files. The process orchestration calls `git ls-files` + `rg`; the line-parsing helpers are pure and unit-tested.

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/RipgrepExtractor.swift`
- Test: `mac/Tests/MeetNotesMacTests/RipgrepExtractorTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import MeetNotesMac

struct RipgrepExtractorTests {
    @Test func detectsLanguageByExtension() {
        #expect(RipgrepExtractor.language(for: "a.ts") == "typescript")
        #expect(RipgrepExtractor.language(for: "a.tsx") == "typescript")
        #expect(RipgrepExtractor.language(for: "a.js") == "javascript")
        #expect(RipgrepExtractor.language(for: "a.jsx") == "javascript")
        #expect(RipgrepExtractor.language(for: "Foo.swift") == "swift")
        #expect(RipgrepExtractor.language(for: "a.py") == "python")
        #expect(RipgrepExtractor.language(for: "README.md") == "other")
    }

    @Test func parsesTSImportSpecifier() {
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import { x } from './foo'", language: "typescript") == "./foo")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import y from \"../bar/baz\"", language: "typescript") == "../bar/baz")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "const z = require('./q')", language: "javascript") == "./q")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import React from 'react'", language: "typescript") == "react")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "let a = 1", language: "typescript") == nil)
    }

    @Test func parsesSwiftImportModule() {
        #expect(RipgrepExtractor.importSpecifier(fromLine: "import Foundation", language: "swift") == "Foundation")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "  import SwiftUI", language: "swift") == "SwiftUI")
        #expect(RipgrepExtractor.importSpecifier(fromLine: "func foo() {}", language: "swift") == nil)
    }

    @Test func parsesSymbolDefinitions() {
        #expect(RipgrepExtractor.symbol(fromLine: "export function doThing(x) {", language: "typescript")?.name == "doThing")
        #expect(RipgrepExtractor.symbol(fromLine: "class Widget {", language: "typescript")?.name == "Widget")
        #expect(RipgrepExtractor.symbol(fromLine: "struct Point {", language: "swift")?.name == "Point")
        #expect(RipgrepExtractor.symbol(fromLine: "func render() -> some View {", language: "swift")?.name == "render")
        #expect(RipgrepExtractor.symbol(fromLine: "// just a comment", language: "swift") == nil)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `error:` mentioning `RipgrepExtractor` not found.

- [ ] **Step 3: Implement RipgrepExtractor.swift**

```swift
import Foundation

/// Extracts structure from non-Python files using ripgrep + git. Pure
/// line-parsing helpers (language/importSpecifier/symbol) are testable in
/// isolation; `run` handles process orchestration.
public final class RipgrepExtractor {
    private let launcher: ProcessLauncher
    private let rgURL: URL?
    private let gitURL: URL?

    public init(launcher: ProcessLauncher,
                rgURL: URL? = RipgrepExtractor.resolve("rg"),
                gitURL: URL? = RipgrepExtractor.resolve("git")) {
        self.launcher = launcher
        self.rgURL = rgURL
        self.gitURL = gitURL
    }

    static func resolve(_ name: String) -> URL? {
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let cand = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
                if FileManager.default.isExecutableFile(atPath: cand.path) { return cand }
            }
        }
        for p in ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)", "/usr/bin/\(name)"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    // MARK: - Pure helpers

    public static func language(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        switch ext {
        case "ts", "tsx":  return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "swift":      return "swift"
        case "py":         return "python"
        default:           return "other"
        }
    }

    static let codeExtensions: Set<String> = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "swift"]

    /// Extract the import specifier from a single source line, or nil.
    public static func importSpecifier(fromLine line: String, language: String) -> String? {
        switch language {
        case "typescript", "javascript":
            // import ... from '<spec>'  |  import '<spec>'  |  require('<spec>')
            if let r = firstQuoted(in: line),
               line.contains("import") || line.contains("require") {
                return r
            }
            return nil
        case "swift":
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("import ") else { return nil }
            let mod = trimmed.dropFirst("import ".count).trimmingCharacters(in: .whitespaces)
            // Strip submodule (`import Foo.Bar` -> "Foo.Bar"); take first token.
            let token = mod.split(whereSeparator: { $0 == " " }).first.map(String.init)
            return (token?.isEmpty == false) ? token : nil
        default:
            return nil
        }
    }

    /// First single- or double-quoted substring in `line`.
    static func firstQuoted(in line: String) -> String? {
        for quote in ["'", "\""] {
            if let start = line.range(of: quote),
               let end = line.range(of: quote, range: start.upperBound..<line.endIndex) {
                return String(line[start.upperBound..<end.lowerBound])
            }
        }
        return nil
    }

    /// Extract a defined symbol (name + kind) from a single line, or nil.
    public static func symbol(fromLine line: String, language: String) -> ScanResult.Symbol? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        func nameAfter(_ keyword: String) -> String? {
            guard let r = trimmed.range(of: keyword + " ") else { return nil }
            let rest = trimmed[r.upperBound...]
            let name = rest.prefix { $0.isLetter || $0.isNumber || $0 == "_" }
            return name.isEmpty ? nil : String(name)
        }
        switch language {
        case "typescript", "javascript":
            if let n = nameAfter("function") { return .init(name: n, kind: "function", line: 0) }
            if let n = nameAfter("class")    { return .init(name: n, kind: "class", line: 0) }
            return nil
        case "swift":
            if let n = nameAfter("func")     { return .init(name: n, kind: "function", line: 0) }
            if let n = nameAfter("class")    { return .init(name: n, kind: "class", line: 0) }
            if let n = nameAfter("struct")   { return .init(name: n, kind: "class", line: 0) }
            if let n = nameAfter("enum")     { return .init(name: n, kind: "class", line: 0) }
            if let n = nameAfter("protocol") { return .init(name: n, kind: "class", line: 0) }
            return nil
        default:
            return nil
        }
    }

    // MARK: - Orchestration

    /// Enumerate code files via `git ls-files` and read each to extract
    /// imports + symbols line-by-line. Skips Python (handled by the AST
    /// extractor). Returns [] if git is unavailable.
    public func run(repoRoot: URL) async -> [RawFileStructure] {
        guard let git = gitURL else { return [] }
        let listing: Data
        do {
            let (exit, out, _) = try await launcher.run(
                executable: git, arguments: ["ls-files"],
                currentDirectory: repoRoot, environment: nil)
            guard exit == 0 else { return [] }
            listing = out
        } catch { return [] }

        let paths = (String(data: listing, encoding: .utf8) ?? "")
            .split(separator: "\n").map(String.init)
            .filter { Self.codeExtensions.contains(($0 as NSString).pathExtension.lowercased()) }

        var results: [RawFileStructure] = []
        for path in paths {
            let lang = Self.language(for: path)
            let url = repoRoot.appendingPathComponent(path)
            guard let content = try? String(contentsOf: url, encoding: .utf8) else { continue }
            var imports: [RawImport] = []
            var symbols: [ScanResult.Symbol] = []
            var loc = 0
            for (idx, raw) in content.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                let line = String(raw)
                if !line.trimmingCharacters(in: .whitespaces).isEmpty { loc += 1 }
                if let spec = Self.importSpecifier(fromLine: line, language: lang) {
                    imports.append(RawImport(module: spec, name: nil))
                }
                if var sym = Self.symbol(fromLine: line, language: lang) {
                    sym = .init(name: sym.name, kind: sym.kind, line: idx + 1)
                    symbols.append(sym)
                }
            }
            results.append(RawFileStructure(path: path, language: lang, loc: loc,
                                            rawImports: imports, symbols: symbols))
        }
        return results.sorted { $0.path < $1.path }
    }
}
```

Note: this reads files in Swift and applies the pure parsers per line (rather than shelling `rg` per pattern) — simpler, fully deterministic, and the per-line parsers are exactly what the tests cover. `git ls-files` provides the (gitignore-respecting) file list.

- [ ] **Step 4: Build tests**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/RipgrepExtractor.swift mac/Tests/MeetNotesMacTests/RipgrepExtractorTests.swift
git commit -m "feat(codenotes): add RipgrepExtractor (git ls-files + per-language line parsers)"
```

---

## Task 5: ImportResolver

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/ImportResolver.swift`
- Test: `mac/Tests/MeetNotesMacTests/ImportResolverTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import MeetNotesMac

struct ImportResolverTests {
    private let files: Set<String> = [
        "pkg/a.py", "pkg/b.py", "pkg/sub/__init__.py",
        "src/foo.ts", "src/bar/baz.ts", "src/bar/index.ts"
    ]

    @Test func resolvesPythonDottedModuleToFile() {
        // from pkg.b import x  -> pkg/b.py
        let r = ImportResolver.resolve(RawImport(module: "pkg.b", name: "x"),
                                       fromFile: "pkg/a.py", language: "python", files: files)
        #expect(r == "pkg/b.py")
    }

    @Test func resolvesPythonPackageInit() {
        let r = ImportResolver.resolve(RawImport(module: "pkg.sub", name: nil),
                                       fromFile: "pkg/a.py", language: "python", files: files)
        #expect(r == "pkg/sub/__init__.py")
    }

    @Test func dropsExternalPythonModule() {
        let r = ImportResolver.resolve(RawImport(module: "os", name: nil),
                                       fromFile: "pkg/a.py", language: "python", files: files)
        #expect(r == nil)
    }

    @Test func resolvesTSRelativeWithExtension() {
        // import from './bar/baz' inside src/foo.ts -> src/bar/baz.ts
        let r = ImportResolver.resolve(RawImport(module: "./bar/baz", name: nil),
                                       fromFile: "src/foo.ts", language: "typescript", files: files)
        #expect(r == "src/bar/baz.ts")
    }

    @Test func resolvesTSRelativeToIndex() {
        // import from './bar' -> src/bar/index.ts
        let r = ImportResolver.resolve(RawImport(module: "./bar", name: nil),
                                       fromFile: "src/foo.ts", language: "typescript", files: files)
        #expect(r == "src/bar/index.ts")
    }

    @Test func dropsBareExternalTSPackage() {
        let r = ImportResolver.resolve(RawImport(module: "react", name: nil),
                                       fromFile: "src/foo.ts", language: "typescript", files: files)
        #expect(r == nil)
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `error:` mentioning `ImportResolver` not found.

- [ ] **Step 3: Implement ImportResolver.swift**

```swift
import Foundation

/// Resolves a RawImport to a repo-internal file path, or nil if it points
/// outside the repo (external package). Pure and deterministic.
public enum ImportResolver {

    public static func resolve(_ imp: RawImport, fromFile: String,
                               language: String, files: Set<String>) -> String? {
        switch language {
        case "python":     return resolvePython(imp, files: files)
        case "typescript", "javascript": return resolveJS(imp, fromFile: fromFile, files: files)
        default:           return nil   // swift/other: no file-level import edges
        }
    }

    // MARK: - Python

    private static func resolvePython(_ imp: RawImport, files: Set<String>) -> String? {
        // Candidates from most to least specific. For `from a.b import c`:
        //   a/b/c.py, a/b/c/__init__.py (c is a submodule), then a/b.py, a/b/__init__.py.
        var dotted = [String]()
        if let name = imp.name, !name.isEmpty {
            dotted.append(imp.module.isEmpty ? name : imp.module + "." + name)
        }
        if !imp.module.isEmpty { dotted.append(imp.module) }

        for d in dotted {
            let base = d.split(separator: ".").joined(separator: "/")
            for cand in ["\(base).py", "\(base)/__init__.py"] where files.contains(cand) {
                return cand
            }
        }
        return nil
    }

    // MARK: - TS / JS

    private static func resolveJS(_ imp: RawImport, fromFile: String, files: Set<String>) -> String? {
        let spec = imp.module
        // Only resolve relative specifiers; bare packages are external.
        guard spec.hasPrefix("./") || spec.hasPrefix("../") else { return nil }

        let dir = (fromFile as NSString).deletingLastPathComponent
        let combined = normalize(joining: dir, spec)

        let exts = ["ts", "tsx", "js", "jsx"]
        // Direct file with extension.
        for e in exts where files.contains("\(combined).\(e)") { return "\(combined).\(e)" }
        // Directory index.
        for e in exts where files.contains("\(combined)/index.\(e)") { return "\(combined)/index.\(e)" }
        // Already has an extension and exists.
        if files.contains(combined) { return combined }
        return nil
    }

    /// Resolve a relative path against a base directory, collapsing . and ..
    static func normalize(joining base: String, _ rel: String) -> String {
        var parts = base.isEmpty ? [] : base.split(separator: "/").map(String.init)
        for comp in rel.split(separator: "/").map(String.init) {
            if comp == "." || comp.isEmpty { continue }
            else if comp == ".." { if !parts.isEmpty { parts.removeLast() } }
            else { parts.append(comp) }
        }
        return parts.joined(separator: "/")
    }
}
```

- [ ] **Step 4: Build tests**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/ImportResolver.swift mac/Tests/MeetNotesMacTests/ImportResolverTests.swift
git commit -m "feat(codenotes): add ImportResolver (Python dotted + TS relative resolution)"
```

---

## Task 6: StructureGraphBuilder (ScanResult → CGData + note merge)

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/StructureGraphBuilder.swift`
- Test: `mac/Tests/MeetNotesMacTests/StructureGraphBuilderTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct StructureGraphBuilderTests {
    private func sampleScan() -> ScanResult {
        ScanResult(
            files: [.init(path: "a.ts", language: "typescript", loc: 10),
                    .init(path: "b.ts", language: "typescript", loc: 5)],
            imports: ["a.ts": ["b.ts"], "b.ts": []],
            symbols: ["a.ts": [.init(name: "foo", kind: "function", line: 3)], "b.ts": []])
    }
    private let repo = URL(fileURLWithPath: "/repo")

    @Test func buildsFileAndSymbolNodes() {
        let g = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        #expect(g.nodes.contains { $0.id == "file:a.ts" && $0.kind == .file })
        #expect(g.nodes.contains { $0.id == "file:b.ts" })
        #expect(g.nodes.contains { $0.id == "function:a.ts:foo" && $0.kind == .function })
    }

    @Test func setsFileURLForDetailPanel() {
        let g = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        let a = g.nodes.first { $0.id == "file:a.ts" }!
        #expect(a.metadata["fileURL"] == "file:///repo/a.ts")
        #expect(a.metadata["source_file"] == "a.ts")
    }

    @Test func buildsImportAndContainsEdges() {
        let g = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        #expect(g.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "file:b.ts" && $0.kind == .imports })
        #expect(g.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "function:a.ts:foo" && $0.kind == .contains })
    }

    @Test func mergeAttachesSummaryAndSemanticEdges() {
        let skeleton = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        let note = CodeNote(id: "file:a.ts", kind: "file", title: "a.ts", path: "a.ts",
                            links: [CodeNote.Link(to: "file:b.ts", kind: "calls")],
                            body: "## Summary\nDoes the thing.\n")
        let merged = StructureGraphBuilder.merge(skeleton: skeleton, notes: [note])
        let a = merged.nodes.first { $0.id == "file:a.ts" }!
        #expect(a.metadata["summary"] == "Does the thing.")
        #expect(merged.edges.contains { $0.fromId == "file:a.ts" && $0.toId == "file:b.ts" && $0.kind == .calls })
        // structural import edge still present
        #expect(merged.edges.contains { $0.kind == .imports && $0.fromId == "file:a.ts" })
    }

    @Test func mergeDropsDanglingSemanticEdges() {
        let skeleton = StructureGraphBuilder.build(sampleScan(), repoRoot: repo)
        let note = CodeNote(id: "file:a.ts", kind: "file", title: "a.ts", path: "a.ts",
                            links: [CodeNote.Link(to: "file:ghost.ts", kind: "calls")])
        let merged = StructureGraphBuilder.merge(skeleton: skeleton, notes: [note])
        #expect(!merged.edges.contains { $0.toId == "file:ghost.ts" })
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `error:` mentioning `StructureGraphBuilder` not found.

- [ ] **Step 3: Implement StructureGraphBuilder.swift**

```swift
import Foundation
import CoreGraphics

/// Builds CGData directly from deterministic structure (ScanResult), and
/// merges background-generated notes (summaries + semantic edges) on top.
public enum StructureGraphBuilder {

    public static func build(_ scan: ScanResult, repoRoot: URL) -> CGData {
        var nodes: [CGNode] = []
        var edges: [CGEdge] = []
        var nodeIds = Set<String>()

        // File nodes.
        for f in scan.files {
            let id = "file:\(f.path)"
            nodeIds.insert(id)
            let abs = repoRoot.appendingPathComponent(f.path).absoluteString
            nodes.append(CGNode(
                id: id,
                title: (f.path as NSString).lastPathComponent,
                kind: .file,
                position: .zero,
                metadata: ["source_file": f.path, "fileURL": abs,
                           "language": f.language, "loc": String(f.loc)]))
        }

        // Symbol nodes + contains edges.
        for f in scan.files {
            let fileId = "file:\(f.path)"
            let abs = repoRoot.appendingPathComponent(f.path).absoluteString
            for sym in scan.symbols[f.path] ?? [] {
                let kind: CGNodeKind = (sym.kind == "class") ? .classType : .function
                let prefix = (sym.kind == "class") ? "class" : "function"
                let id = "\(prefix):\(f.path):\(sym.name)"
                guard !nodeIds.contains(id) else { continue }
                nodeIds.insert(id)
                nodes.append(CGNode(
                    id: id, title: sym.name, kind: kind, position: .zero,
                    metadata: ["source_file": f.path, "fileURL": abs, "line": "L\(sym.line)"]))
                edges.append(CGEdge(fromId: fileId, toId: id, kind: .contains))
            }
        }

        // Import edges (resolved file → file).
        for (src, targets) in scan.imports {
            let srcId = "file:\(src)"
            guard nodeIds.contains(srcId) else { continue }
            for t in targets {
                let dstId = "file:\(t)"
                guard nodeIds.contains(dstId) else { continue }
                edges.append(CGEdge(fromId: srcId, toId: dstId, kind: .imports))
            }
        }

        return CGData(nodes: nodes, edges: edges)
    }

    /// Merge notes into a structural skeleton: set each matching node's
    /// `summary` metadata and add the note's semantic links as edges on top
    /// (deduped; dangling dropped). Structural edges are preserved.
    public static func merge(skeleton: CGData, notes: [CodeNote]) -> CGData {
        let nodeIds = Set(skeleton.nodes.map { $0.id })
        let summaryById: [String: String] = Dictionary(
            notes.compactMap { n -> (String, String)? in
                let s = summaryLine(n.body)
                return s.isEmpty ? nil : (n.id, s)
            }, uniquingKeysWith: { a, _ in a })

        let nodes = skeleton.nodes.map { node -> CGNode in
            guard let summary = summaryById[node.id] else { return node }
            var meta = node.metadata
            meta["summary"] = summary
            return CGNode(id: node.id, title: node.title, kind: node.kind,
                          position: node.position, metadata: meta)
        }

        var edges = skeleton.edges
        var seen = Set(edges.map { "\($0.fromId)|\($0.toId)|\($0.kind.rawValue)" })
        for note in notes {
            guard nodeIds.contains(note.id) else { continue }
            for link in note.links where nodeIds.contains(link.to) {
                let kind = UAParser.mapEdgeType(link.kind)
                // Only add semantic (non-structural) edges here; imports/contains
                // already come from structure.
                if kind == .imports || kind == .contains { continue }
                let key = "\(note.id)|\(link.to)|\(kind.rawValue)"
                if seen.insert(key).inserted {
                    edges.append(CGEdge(fromId: note.id, toId: link.to, kind: kind))
                }
            }
        }
        return CGData(nodes: nodes, edges: edges)
    }

    /// First prose line under "## Summary", else first non-heading line.
    static func summaryLine(_ body: String) -> String {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        var sawSummary = false
        for line in lines {
            if line.lowercased().hasPrefix("## summary") { sawSummary = true; continue }
            if sawSummary && !line.isEmpty { return line }
        }
        for line in lines where !line.isEmpty && !line.hasPrefix("#") { return line }
        return ""
    }
}
```

- [ ] **Step 4: Build tests**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/StructureGraphBuilder.swift mac/Tests/MeetNotesMacTests/StructureGraphBuilderTests.swift
git commit -m "feat(codenotes): add StructureGraphBuilder (ScanResult -> CGData + note merge)"
```

---

## Task 7: StructureScanner

**Files:**
- Create: `mac/Sources/MeetNotesMac/CodeNotes/StructureScanner.swift`
- Test: `mac/Tests/MeetNotesMacTests/StructureScannerTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import MeetNotesMac

struct StructureScannerTests {
    @Test func assemblesScanResultAndResolvesImports() {
        let raws: [RawFileStructure] = [
            RawFileStructure(path: "pkg/a.py", language: "python", loc: 10,
                             rawImports: [RawImport(module: "pkg.b", name: "x"),
                                          RawImport(module: "os", name: nil)],
                             symbols: [.init(name: "run", kind: "function", line: 1)]),
            RawFileStructure(path: "pkg/b.py", language: "python", loc: 4,
                             rawImports: [], symbols: []),
        ]
        let scan = StructureScanner.assemble(raws)
        #expect(scan.files.count == 2)
        #expect(scan.imports["pkg/a.py"] == ["pkg/b.py"])   // pkg.b resolved, os dropped
        #expect(scan.symbols["pkg/a.py"]?.first?.name == "run")
    }

    @Test func mergesPythonAndRipgrepResultsByPath() {
        let py = [RawFileStructure(path: "a.py", language: "python", loc: 1, rawImports: [], symbols: [])]
        let rg = [RawFileStructure(path: "b.ts", language: "typescript", loc: 1, rawImports: [], symbols: [])]
        let scan = StructureScanner.assemble(py + rg)
        #expect(Set(scan.files.map { $0.path }) == ["a.py", "b.ts"])
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `error:` mentioning `StructureScanner` not found.

- [ ] **Step 3: Implement StructureScanner.swift**

```swift
import Foundation

/// Runs the hybrid extractors (Python AST + ripgrep) and assembles a
/// resolved ScanResult. Pure assembly (`assemble`) is separated from process
/// orchestration (`scan`) for testability.
public final class StructureScanner {
    private let python: PythonASTExtractor
    private let ripgrep: RipgrepExtractor

    public init(launcher: ProcessLauncher) {
        self.python = PythonASTExtractor(launcher: launcher)
        self.ripgrep = RipgrepExtractor(launcher: launcher)
    }

    /// Full scan: run both extractors, merge, resolve imports → ScanResult.
    public func scan(repoRoot: URL) async -> ScanResult {
        async let py = python.run(repoRoot: repoRoot)
        async let rg = ripgrep.run(repoRoot: repoRoot)
        let raws = await py + rg
        return Self.assemble(raws)
    }

    /// Pure: turn raw per-file structures into a resolved ScanResult.
    public static func assemble(_ raws: [RawFileStructure]) -> ScanResult {
        // Deduplicate by path (Python extractor wins for .py; ripgrep skips .py).
        var byPath: [String: RawFileStructure] = [:]
        for r in raws where byPath[r.path] == nil { byPath[r.path] = r }
        let all = byPath.values.sorted { $0.path < $1.path }
        let fileSet = Set(all.map { $0.path })

        var files: [ScanResult.FileEntry] = []
        var imports: [String: [String]] = [:]
        var symbols: [String: [ScanResult.Symbol]] = [:]

        for r in all {
            files.append(.init(path: r.path, language: r.language, loc: r.loc))
            symbols[r.path] = r.symbols
            var resolved: [String] = []
            for imp in r.rawImports {
                if let target = ImportResolver.resolve(imp, fromFile: r.path,
                                                       language: r.language, files: fileSet),
                   target != r.path {
                    resolved.append(target)
                }
            }
            // Dedupe while preserving order.
            var seen = Set<String>()
            imports[r.path] = resolved.filter { seen.insert($0).inserted }
        }
        return ScanResult(files: files, imports: imports, symbols: symbols)
    }
}
```

- [ ] **Step 4: Build tests**

Run: `cd mac && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!`

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/StructureScanner.swift mac/Tests/MeetNotesMacTests/StructureScannerTests.swift
git commit -m "feat(codenotes): add StructureScanner (hybrid extract + resolve -> ScanResult)"
```

---

## Task 8: Rewrite CodeNoteService (fast graph + background notes)

**Files:**
- Modify: `mac/Sources/MeetNotesMac/CodeNotes/CodeNoteService.swift`

- [ ] **Step 1: Replace the file contents**

Replace the entire body of `CodeNoteService.swift` with:

```swift
import Foundation
import Combine

/// Generates the code graph in two layers: an instant deterministic
/// structural skeleton, then background LLM-note enrichment that merges
/// summaries + semantic edges into the published graph.
@MainActor
public final class CodeNoteService: ObservableObject {
    public enum Progress: Equatable {
        case idle
        case extracting
        case buildingGraph
        case enriching(done: Int, total: Int)
        case complete(files: Int, edges: Int, skipped: Int)
        case failed(String)
    }

    @Published public private(set) var progress: Progress = .idle
    /// The current graph. Published so the UI re-renders as enrichment lands.
    @Published public private(set) var graph: CGData = .empty

    private let launcher: ProcessLauncher
    private let cliExecutable: URL
    private let maxBatchSize: Int
    private let maxConcurrentBatches: Int

    public init(launcher: ProcessLauncher,
                cliExecutable: URL,
                maxBatchSize: Int = 20,
                maxConcurrentBatches: Int = 5) {
        self.launcher = launcher
        self.cliExecutable = cliExecutable
        self.maxBatchSize = maxBatchSize
        self.maxConcurrentBatches = maxConcurrentBatches
    }

    static func resolveCLI(_ tool: AICliTool) -> URL? {
        let name = tool.cliExecutable.split(separator: " ").first.map(String.init) ?? tool.cliExecutable
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                let cand = URL(fileURLWithPath: String(dir)).appendingPathComponent(name)
                if FileManager.default.isExecutableFile(atPath: cand.path) { return cand }
            }
        }
        for p in ["/opt/homebrew/bin/\(name)", "/usr/local/bin/\(name)"] {
            if FileManager.default.isExecutableFile(atPath: p) { return URL(fileURLWithPath: p) }
        }
        return nil
    }

    /// Build the structural graph now; kick off note enrichment in the
    /// background. Returns the skeleton immediately.
    public func generate(repoRoot: URL) async -> Result<CGData, CodeNoteError> {
        if !FileManager.default.isWritableFile(atPath: repoRoot.path) {
            progress = .failed("folder not writable"); return .failure(.folderNotWritable(path: repoRoot.path))
        }

        // PHASE 1 — extract structure (app-run, no LLM).
        progress = .extracting
        let scan = await StructureScanner(launcher: launcher).scan(repoRoot: repoRoot)

        // PHASE 2 — build + publish the skeleton.
        progress = .buildingGraph
        let skeleton = StructureGraphBuilder.build(scan, repoRoot: repoRoot)
        self.graph = skeleton

        // PHASE 3 — background note enrichment (non-blocking).
        let batches = batchesForEnrichment(scan: scan, repoRoot: repoRoot)
        progress = .enriching(done: 0, total: batches.count)
        if batches.isEmpty {
            progress = .complete(files: scan.files.count, edges: skeleton.edges.count, skipped: 0)
        } else {
            Task.detached { [weak self] in
                await self?.enrich(batches: batches, scan: scan,
                                   skeleton: skeleton, repoRoot: repoRoot)
            }
        }
        return .success(skeleton)
    }

    // MARK: - Enrichment

    private func batchesForEnrichment(scan: ScanResult, repoRoot: URL) -> [CodeBatch] {
        let codeNotesDir = repoRoot.appendingPathComponent(".code-notes")
        let fpURL = codeNotesDir.appendingPathComponent("fingerprints.json")
        let current = currentHashes(scan: scan, repoRoot: repoRoot)
        let previous = FingerprintStore.load(from: fpURL).hashes
        let classification = Fingerprint.classify(previous: previous, current: current)
        // Remove notes for deleted files.
        let notesDir = codeNotesDir.appendingPathComponent("notes")
        for path in classification.deleted {
            try? FileManager.default.removeItem(at: noteURL(notesDir: notesDir, path: path))
        }
        return BatchPlanner.plan(files: classification.changed,
                                 imports: scan.imports, maxBatchSize: maxBatchSize)
    }

    private func enrich(batches: [CodeBatch], scan: ScanResult,
                        skeleton: CGData, repoRoot: URL) async {
        // Capture only Sendable values for the off-actor task closures; build a
        // fresh AnalyzePhase inside each task (the class isn't Sendable, so we
        // must not capture an instance across the concurrency boundary).
        let launcher = self.launcher
        let cli = self.cliExecutable
        let codeNotesDir = repoRoot.appendingPathComponent(".code-notes")
        let notesDir = codeNotesDir.appendingPathComponent("notes")
        let fpURL = codeNotesDir.appendingPathComponent("fingerprints.json")

        var done = 0
        var failedFiles = Set<String>()

        // Run batches in bounded-concurrency waves.
        var index = 0
        while index < batches.count {
            let slice = Array(batches[index..<min(index + maxConcurrentBatches, batches.count)])
            await withTaskGroup(of: (CodeBatch, Bool).self) { group in
                for batch in slice {
                    group.addTask {
                        let analyze = AnalyzePhase(launcher: launcher, cliExecutable: cli)
                        let r = await analyze.run(batch: batch, scan: scan, repoRoot: repoRoot)
                        if case .success = r { return (batch, true) }
                        return (batch, false)
                    }
                }
                for await (batch, ok) in group {
                    if !ok { failedFiles.formUnion(batch.files) }
                    done += 1
                    let mergedGraph = self.rebuildEnriched(skeleton: skeleton, notesDir: notesDir)
                    self.publish(graph: mergedGraph,
                                 progress: .enriching(done: done, total: batches.count))
                }
            }
            index += maxConcurrentBatches
        }

        // Persist fingerprints (excluding failed files so they retry).
        let current = currentHashes(scan: scan, repoRoot: repoRoot)
        var toPersist = current
        for f in failedFiles { toPersist[f] = nil }
        try? FingerprintStore(hashes: toPersist).save(to: fpURL)

        let finalGraph = rebuildEnriched(skeleton: skeleton, notesDir: notesDir)
        try? IndexWriter.write(notes: loadAllNotes(notesDir: notesDir),
                               to: codeNotesDir.appendingPathComponent("index.md"))
        publish(graph: finalGraph,
                progress: .complete(files: scan.files.count,
                                    edges: finalGraph.edges.count,
                                    skipped: failedFiles.count))
    }

    /// Merge all on-disk notes into the skeleton (summaries + semantic edges).
    private nonisolated func rebuildEnriched(skeleton: CGData, notesDir: URL) -> CGData {
        StructureGraphBuilder.merge(skeleton: skeleton, notes: loadAllNotes(notesDir: notesDir))
    }

    private func publish(graph: CGData, progress: Progress) {
        self.graph = graph
        self.progress = progress
    }

    // MARK: - Helpers

    private nonisolated func currentHashes(scan: ScanResult, repoRoot: URL) -> [String: String] {
        var out: [String: String] = [:]
        for f in scan.files {
            let url = repoRoot.appendingPathComponent(f.path)
            if let data = try? Data(contentsOf: url) { out[f.path] = Fingerprint.hash(of: data) }
        }
        return out
    }

    private nonisolated func noteURL(notesDir: URL, path: String) -> URL {
        notesDir.appendingPathComponent("\(path).md")
    }

    private nonisolated func loadAllNotes(notesDir: URL) -> [CodeNote] {
        guard let en = FileManager.default.enumerator(at: notesDir, includingPropertiesForKeys: nil)
        else { return [] }
        var notes: [CodeNote] = []
        for case let url as URL in en where url.pathExtension == "md" {
            if let note = try? CodeNoteWriter.read(from: url) { notes.append(note) }
        }
        return notes.sorted { $0.id < $1.id }
    }
}
```

Note on actors: the class is `@MainActor`, so `enrich` runs on the main actor (the detached task does `await self?.enrich(...)`, hopping to the main actor). Calls to `publish` from within `enrich` are therefore synchronous (same actor). The `withTaskGroup` child closures are off-actor `@Sendable` — they capture only Sendable values (`launcher`, `cli`, `scan`, `batch`, `repoRoot`) and build their own `AnalyzePhase`, so the subprocess waits run concurrently without blocking the main actor. `currentHashes`/`noteURL`/`loadAllNotes`/`rebuildEnriched` are `nonisolated` so they can run off-actor too. If the compiler flags `AnalyzePhase`/`ScanResult`/`CodeBatch` as non-Sendable when captured, add `Sendable` conformance (they hold only value types + a Sendable launcher).

- [ ] **Step 2: Build (sources)**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: errors only from the view referencing removed `Progress` cases (`.scanning`, `.analyzing`, `.deriving`, `.done`) — fixed in Task 9. Source-level CodeNoteService itself should compile; if it reports errors inside CodeNoteService.swift, fix them. (References from `ScanPhase`/`EdgeRecovery` are removed in Task 10.)

- [ ] **Step 3: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/CodeNotes/CodeNoteService.swift
git commit -m "feat(codenotes): rewrite CodeNoteService for instant graph + background note enrichment"
```

---

## Task 9: Update the view (observe $graph, new progress labels)

**Files:**
- Modify: `mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift`

- [ ] **Step 1: Make generateCodeNotes rely on published graph**

Find `generateCodeNotes(target:)` (around line 1188). Replace it with a version that just triggers generation and lets the `$graph` observer render:

```swift
    private func generateCodeNotes(target: URL) {
        status = .running
        Task {
            let result = await codeNoteService.generate(repoRoot: target)
            if case .failure(let err) = result {
                await MainActor.run { self.status = .error("\(err)") }
            }
            // Success rendering is driven by the codeNoteService.$graph observer
            // (set up in Step 2), so the background enrichment updates also flow in.
        }
    }
```

- [ ] **Step 2: Observe the service's published graph**

Find the main view `body` (the top-level `var body: some View`). Add an `.onReceive` that recomputes `fullData` whenever the service republishes its graph. Add this modifier to the same view that already has `.onChange(of: fullData)` (around line 422) — append after it:

```swift
        .onReceive(codeNoteService.$graph) { newGraph in
            guard mode == .code, !newGraph.nodes.isEmpty else { return }
            self.selectedNode = self.selectedNode  // keep selection
            self.fullData = CodeGraphLayout.compute(
                newGraph, canvasSize: UAHelpers.layoutSize(for: newGraph.nodes.count))
            self.codeArtifacts = UAHelpers.collectCodeArtifacts(newGraph)
            if case .complete(let f, let e, _) = codeNoteService.progress {
                self.status = .loaded(nodeCount: f, edgeCount: e)
            }
        }
```

(`import Combine` is already implied by SwiftUI; if the compiler complains that `$graph` / `.onReceive` is unavailable, add `import Combine` at the top of the file.)

- [ ] **Step 3: Update the progress view to the new Progress cases**

Find `codeNotesProgressView` (around line 1209). Replace its `switch` body with the new cases:

```swift
    @ViewBuilder
    private var codeNotesProgressView: some View {
        let t = theme.current
        switch codeNoteService.progress {
        case .idle:
            EmptyView()
        case .extracting:
            Text("Extracting structure…")
                .font(Typography.caption).foregroundStyle(t.textMuted)
        case .buildingGraph:
            Text("Building graph…")
                .font(Typography.caption).foregroundStyle(t.textMuted)
        case .enriching(let d, let total):
            Text("Enriching notes \(d)/\(total)…")
                .font(Typography.caption).foregroundStyle(t.textMuted)
        case .complete(let f, let e, let skipped):
            Text("\(f) files · \(e) edges" + (skipped > 0 ? " · \(skipped) skipped" : ""))
                .font(Typography.caption).foregroundStyle(t.accent3)
        case .failed(let msg):
            Text(msg).font(Typography.caption).foregroundStyle(.red)
        }
    }
```

- [ ] **Step 4: Fix any other references to old Progress cases**

Run: `cd mac && grep -n 'codeNoteService.progress\|\.scanning\|\.analyzing\|\.deriving' Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift`
Fix any remaining match that referenced the old `.scanning`/`.analyzing`/`.deriving`/`.done` cases to use the new ones (only `codeNotesProgressView` should reference them).

- [ ] **Step 5: Build**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete'`
Expected: `Build complete!` (fix any remaining mismatches).

- [ ] **Step 6: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add mac/Sources/MeetNotesMac/Views/CodeGraph/UAGraphView.swift
git commit -m "feat(ui): render structural graph instantly, observe background enrichment"
```

---

## Task 10: Delete dead code (ScanPhase, EdgeRecovery)

**Files:**
- Delete: `ScanPhase.swift`, `ScanPhaseTests.swift`, `EdgeRecovery.swift`, `EdgeRecoveryTests.swift`

- [ ] **Step 1: Confirm they're unreferenced**

Run: `cd mac && grep -rn 'ScanPhase\|EdgeRecovery' Sources Tests`
Expected: matches only inside the four files about to be deleted. If any other file references them, fix that first (there should be none after Task 8).

- [ ] **Step 2: Delete**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git rm mac/Sources/MeetNotesMac/CodeNotes/ScanPhase.swift
git rm mac/Tests/MeetNotesMacTests/ScanPhaseTests.swift
git rm mac/Sources/MeetNotesMac/CodeNotes/EdgeRecovery.swift
git rm mac/Tests/MeetNotesMacTests/EdgeRecoveryTests.swift
```

- [ ] **Step 3: Build + build tests**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete' && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: both `Build complete!`.

- [ ] **Step 4: Commit**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git commit -m "chore(codenotes): remove ScanPhase + EdgeRecovery (superseded by structural pipeline)"
```

---

## Task 11: Full verification — build, bundle, launch

- [ ] **Step 1: Clean build + tests compile**

Run: `cd mac && swift build 2>&1 | grep -E 'error:|Build complete' && swift build --build-tests 2>&1 | grep -E 'error:|Build complete'`
Expected: both `Build complete!`.

- [ ] **Step 2: Build the app bundle**

Run: `cd mac && bash Scripts/build.sh 2>&1 | tail -3`
Expected: `[build] ok — …/MeetNotesMac.app`.

- [ ] **Step 3: Confirm the Python script is bundled**

Run: `ls mac/MeetNotesMac.app/Contents/Resources/code_ast_scan.py && echo OK`
Expected: the path prints, then `OK`. (build.sh rsyncs `Sources/.../Resources`; if the SPM resource lands elsewhere, also check `find mac/MeetNotesMac.app -name code_ast_scan.py`.)

- [ ] **Step 4: Launch + smoke test**

Run: `pkill -9 MeetNotesMac 2>/dev/null; sleep 1; open mac/MeetNotesMac.app`
Verify: select a repo → Code Graph → **Generate Code Graph**. The graph appears within seconds ("Extracting structure… → Building graph…"), then "Enriching notes N/M…" updates in the background. Click a file node → its content shows in the detail panel; once its note lands, the summary appears too.

- [ ] **Step 5: Final commit + push**

```bash
cd /Users/dinesh.malla/Desktop/meet-notes
git add -A && git commit -m "chore: fast AST code graph complete" --allow-empty
git push origin main
```
