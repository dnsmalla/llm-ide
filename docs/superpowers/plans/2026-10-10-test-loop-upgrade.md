# Test Loop Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers use `model: sonnet`; reviewers use `model: fable`. Implementers never spawn sub-agents.

**Goal:** Upgrade the Loop menu's **Test** loop from "run the test command" into a systematic pipeline: make sure the repo has a test folder and runner, use the code graph to find the functions that matter and have no test, generate tests for them into that structure, run the suite, and turn every new failure into a tracked regression the existing Regression loop can repair.

**Architecture:** One new native stage kind `.testMap` with three operations, all deterministic Swift (no model): **structure** (detect test roots + runners, write `llm-doc/loop/test/TEST-STRUCTURE.md`), **map** (read `system/graph/graph.json` + the test files, write `llm-doc/loop/test/TEST-MAP.md` ranking untested functions by fan-in), and **ledger** (diff this run's failing test ids against the last run's, write a `FaultReport` with a runnable `verify` command for each new failure, mark the fault fixed when it passes again). Two kit skills do the only model work: `test-structure-setup` (creates the folder + runner wiring when none exists; enabled by detection only) and `test-gap-writer` (writes tests for the top untested functions of ONE source file per run, into the structure). A native guard makes the writer safe to schedule: it may only CREATE files under the detected test roots; anything else is reverted and the stage fails, so the Test loop stays schedulable.

**Tech Stack:** Swift/SwiftUI (`mac/`), the `.skills` kit, existing Loop runner (`/kb/loop/agent-run`, `RepairScopeGuard`, `TestFailureExtractor`, `MemoryStore`/`FaultReport`, `LoopRunJournal`).

**Spec (from the user, 2026-10-10):** "Test first: we need a test folder in the repo, then use the code graph to find the function and then generate related tests. We also need structure for adding tests and other too, so we can run tests and find the regression and update correctly. Do only this in one plan." Decisions taken to implement that:
- **Structure is explicit and written down.** `TEST-STRUCTURE.md` lists every test root, its runner, the exact command, the file-naming rule, and where a new test for `path/X.ext` goes. Skills read it; they never guess.
- **The code graph decides what to test.** Functions are ranked by their file's fan-in (`usedBy` count in `graph.json`) then by file size; a function counts as tested when a test file under a test root mentions it. When `graph.json` is missing (graph feature compiled out or never generated), the map falls back to file-level mapping and says so.
- **Generated tests must be real and must land in the structure.** The writer follows `TEST-STRUCTURE.md`'s naming rule; the native guard rejects any change outside the test roots or any modification of an existing file.
- **Regressions become faults.** A test that fails in this run but passed in the last recorded run gets a `FaultReport` under `system/faults/` with `verify` set to a command that runs only that test, tagged `test:<id>`. A fault whose test passes again is marked `fixed`. The Regression loop then repairs faults exactly as it does today.
- **The Test loop stays scheduled.** Only the test-only writer is allowed in a scheduled loop; `test-structure-setup` is enabled only when detection finds no runner and is a one-shot.
- **Out of scope:** the Refactoring loop, coverage tools, mutation testing, multi-repo projects (one git root per run as today).

## Global Constraints

- Never push any repo. Commits on branches: llm-ide `feat/test-loop-upgrade`, `.skills` `feat/test-loop-skills`. Stage the `.skills` gitlink only in Task 8.
- Mac tests: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > $TMPDIR/mac-test.log 2>&1` (unsandboxed; sandboxed `swift build` fails with "Invalid manifest"). Assert the XCTest "Executed N tests, with 0 failures" line AND the swift-testing "✔ Test run with N tests" line. Never run two swift builds at once.
- `mac/Scripts/feature-boundaries.sh` exits 0. `Features/Loop` must not import `GraphCore`, `GraphKit` or anything under `Features/CodeGraph` — it reads `graph.json` with its own Codable struct. (`GraphCore` is linked only when `code_graph_3d` is compiled in: `mac/Package.swift:230-233`.)
- Stage prompts are PATH-AGNOSTIC ("the Input" / "the Output path"); paths live in `targetPath` / `outputPath`.
- New `LoopStage.Kind` case decodes as `.unsupported` on older builds; record the downgrade note in `CHANGELOG.md` (Task 8).
- `grep` is aliased to ugrep — use `/usr/bin/grep`. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Conventional Commits, one concern per commit.
- `make docs-check` passes when `docs/` changes.

## File Structure

| Path | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/Features/Loop/Services/TestSourceMapper.swift` | NEW. Pure language rules: is this a test file, which source stem is it for, does it contain a test marker, where does a new test for `X` go. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/TestStructure.swift` | NEW. `TestRoot` (dir, runner, command, namingRule), `TestStructure` (roots, status), Markdown rendering. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/TestStructureDetector.swift` | NEW. Finds manifests up to depth 2, derives roots + commands; writes `TEST-STRUCTURE.{md,json}`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/GraphIndex.swift` | NEW. Codable for `system/graph/graph.json` (`files[].path/loc/usedBy/functions[].name/line`). Read-only. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/TestMapBuilder.swift` | NEW. GraphIndex + test-file text → `TestMap` (per function: tested?, fanIn); writes `TEST-MAP.{md,json}`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/TestMap.swift` | NEW. `TestMap`, `TestMapEntry`, counters, delta rule (`untestedFunctions` must fall after a write stage). |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/TestLedger.swift` | NEW. `ledger.json` (last run's failing + passing ids) and the diff → `newFailures`, `fixed`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/VerifyCommandBuilder.swift` | NEW. Pure: (runner, test id, package dir) → single-test command. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/RegressionFaultSync.swift` | NEW. new failures → `FaultReport` via `MemoryStore`; fixed → status `fixed`. |
| `mac/Sources/LlmIdeMac/Core/Memory/MemoryStore.swift` | MODIFY. Add `rewriteFault(at url: URL, _ fault: FaultReport)`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopStage.swift` | MODIFY. `Kind.testMap`, `testOp: TestMapOp?`, `testWriteOnly`, `codeApplySkillIds` += writer + setup. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopDefinition.swift` | MODIFY. `isManualOnly` ignores `testWriteOnly` stages. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner.swift` | MODIFY. Dispatch `.testMap`; post-check for `testWriteOnly` stages; attach `testMapDelta` to the attempt. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopRunRecord.swift` | MODIFY. `LoopStageAttempt.testMapDelta: [String: Double]?`, `newFaults: [String]?`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopStageDetector.swift` | MODIFY. New Test loop stage list (revision bump), `go test` / `cargo test` detection, setup stage gated by detection. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopOutputLayout.swift` | MODIFY. `testDir`, `testStructureMD/JSON`, `testMapMD/JSON`, `testLedger`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopRunSummaryWriter.swift` | MODIFY. Print untested-function delta and new faults. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopTemplate.swift` | MODIFY. Test template matches the new stage list. |
| `.skills/skills/test-structure-setup/SKILL.md`, `.skills/skills/test-gap-writer/SKILL.md`, `.skills/registry.yaml` | NEW/MODIFY. |
| `mac/Tests/LlmIdeMacTests/{TestSourceMapperTests,TestStructureDetectorTests,TestMapBuilderTests,TestLedgerTests,VerifyCommandBuilderTests,RegressionFaultSyncTests,LoopStageDetectorTestLoopTests}.swift` | NEW. |
| `docs/explanation/loop-engineering.md`, `docs/spec/macos-app.md`, `CHANGELOG.md` | MODIFY. |

---

### Task 1: TestSourceMapper (pure mapping + placement rules)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/Loop/Services/TestSourceMapper.swift`
- Test: `mac/Tests/LlmIdeMacTests/TestSourceMapperTests.swift`

**Interfaces (produces):**
```swift
enum TestSourceMapper {
    static let excludedDirs: Set<String>   // .git node_modules .build dist build Pods DerivedData vendor .venv __pycache__ .llmide-loop-worktrees monaco monaco-src
    static let codeExtensions: Set<String> // swift mjs cjs js jsx ts tsx py go kt
    static func isSourceCandidate(_ relPath: String) -> Bool
    static func isTestPath(_ relPath: String) -> Bool
    static func sourceStem(forTestPath relPath: String) -> String?     // "X/FooTests.swift" → "Foo"
    static func sourceStem(forSourcePath relPath: String) -> String?   // "Foo+Ext.swift" → "Foo"
    static func containsTestMarker(_ text: String) -> Bool
    /// File name a NEW test for `sourceRelPath` must have, by language. "Foo.swift" → "FooTests.swift", "db.mjs" → "db.test.mjs", "p.py" → "test_p.py", "p.go" → "p_test.go", "A.kt" → "ATest.kt".
    static func testFileName(forSourcePath sourceRelPath: String) -> String?
}
```

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class TestSourceMapperTests: XCTestCase {
    func testSwiftRules() {
        XCTAssertTrue(TestSourceMapper.isTestPath("mac/Tests/LlmIdeMacTests/FooBarTests.swift"))
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "mac/Tests/LlmIdeMacTests/FooBarTests.swift"), "FooBar")
        XCTAssertEqual(TestSourceMapper.sourceStem(forSourcePath: "mac/Sources/A/FooBar+History.swift"), "FooBar")
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "mac/Sources/A/FooBar.swift"), "FooBarTests.swift")
    }
    func testOtherLanguages() {
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "extension/tests/vault.test.mjs"), "vault")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "src/__tests__/widget.tsx"), "widget")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "pkg/test_parser.py"), "parser")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "pkg/parser_test.go"), "parser")
        XCTAssertNil(TestSourceMapper.sourceStem(forTestPath: "src/widget.tsx"))
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "extension/kb/db.mjs"), "db.test.mjs")
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "pkg/parser.py"), "test_parser.py")
        XCTAssertEqual(TestSourceMapper.testFileName(forSourcePath: "pkg/parser.go"), "parser_test.go")
        XCTAssertNil(TestSourceMapper.testFileName(forSourcePath: "README.md"))
    }
    func testSourceCandidate() {
        XCTAssertTrue(TestSourceMapper.isSourceCandidate("extension/kb/db.mjs"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("extension/tests/db.test.mjs"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("mac/Package.swift"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("node_modules/x/index.js"))
    }
    func testMarkers() {
        for s in ["final class A: XCTestCase { func testX() {} }", "@Test func parses() {}", "test('adds', () => {})",
                  "it('adds', () => {})", "def test_adds():", "func TestAdds(t *testing.T) {"] {
            XCTAssertTrue(TestSourceMapper.containsTestMarker(s), s)
        }
        XCTAssertFalse(TestSourceMapper.containsTestMarker("// placeholder"))
    }
}
```

- [ ] **Step 2: Run** `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter TestSourceMapperTests > $TMPDIR/t.log 2>&1; /usr/bin/grep -E "error:|Executed" $TMPDIR/t.log | head` — expected: compile error "cannot find 'TestSourceMapper'".
- [ ] **Step 3: Implement**

```swift
import Foundation

/// Every language rule for "which test file is FOR which source file" and
/// "where a new test goes", so the structure stage, the map stage and the
/// test-gap-writer skill's contract cannot disagree.
enum TestSourceMapper {
    static let excludedDirs: Set<String> = [".git", "node_modules", ".build", "dist", "build", "Pods", "DerivedData",
                                            "vendor", ".venv", "__pycache__", ".llmide-loop-worktrees", "monaco", "monaco-src"]
    static let codeExtensions: Set<String> = ["swift", "mjs", "cjs", "js", "jsx", "ts", "tsx", "py", "go", "kt"]
    private static let manifests: Set<String> = ["Package.swift"]

    static func isSourceCandidate(_ relPath: String) -> Bool {
        let parts = relPath.split(separator: "/").map(String.init)
        guard let file = parts.last, !parts.dropLast().contains(where: { excludedDirs.contains($0) }) else { return false }
        let (_, ext) = splitExt(file)
        guard codeExtensions.contains(ext), !manifests.contains(file) else { return false }
        return !isTestPath(relPath)
    }
    static func isTestPath(_ relPath: String) -> Bool { sourceStem(forTestPath: relPath) != nil }

    static func sourceStem(forTestPath relPath: String) -> String? {
        let parts = relPath.split(separator: "/").map(String.init)
        guard let file = parts.last else { return nil }
        let dirs = parts.dropLast()
        let (name, ext) = splitExt(file)
        guard codeExtensions.contains(ext) else { return nil }
        switch ext {
        case "swift":
            if name.hasSuffix("Tests") { return String(name.dropLast(5)) }
            if name.hasSuffix("Test") { return String(name.dropLast(4)) }
            return nil
        case "mjs", "cjs", "js", "jsx", "ts", "tsx":
            if name.hasSuffix(".test") || name.hasSuffix(".spec") { return String(name.dropLast(5)) }
            if dirs.contains("__tests__") || dirs.contains("tests") || dirs.contains("test") { return name }
            return nil
        case "py":
            if name.hasPrefix("test_") { return String(name.dropFirst(5)) }
            if name.hasSuffix("_test") { return String(name.dropLast(5)) }
            return nil
        case "go": return name.hasSuffix("_test") ? String(name.dropLast(5)) : nil
        case "kt": return name.hasSuffix("Test") ? String(name.dropLast(4)) : nil
        default: return nil
        }
    }
    static func sourceStem(forSourcePath relPath: String) -> String? {
        guard let file = relPath.split(separator: "/").last.map(String.init) else { return nil }
        return splitExt(file).0.split(separator: "+").first.map(String.init)
    }
    static func testFileName(forSourcePath relPath: String) -> String? {
        guard let file = relPath.split(separator: "/").last.map(String.init) else { return nil }
        let (name, ext) = splitExt(file)
        guard codeExtensions.contains(ext) else { return nil }
        let stem = name.split(separator: "+").first.map(String.init) ?? name
        switch ext {
        case "swift": return "\(stem)Tests.swift"
        case "mjs", "cjs", "js", "jsx", "ts", "tsx": return "\(stem).test.\(ext)"
        case "py": return "test_\(stem).py"
        case "go": return "\(stem)_test.go"
        case "kt": return "\(stem)Test.kt"
        default: return nil
        }
    }
    static func containsTestMarker(_ text: String) -> Bool {
        ["func test", "@Test", "test(", "it(", "def test_", "func Test", "fun test", "@org.junit.Test"].contains { text.contains($0) }
    }
    private static func splitExt(_ file: String) -> (String, String) {
        guard let dot = file.lastIndex(of: ".") else { return (file, "") }
        return (String(file[..<dot]), String(file[file.index(after: dot)...]))
    }
}
```

- [ ] **Step 4: Run** — "Executed 4 tests, with 0 failures".
- [ ] **Step 5: Commit** — `git add mac/Sources/LlmIdeMac/Features/Loop/Services/TestSourceMapper.swift mac/Tests/LlmIdeMacTests/TestSourceMapperTests.swift && git commit -m "feat(mac): TestSourceMapper — test↔source and test-placement rules in one place"`

### Task 2: Test structure detection + TEST-STRUCTURE.md

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/Loop/Models/TestStructure.swift`, `mac/Sources/LlmIdeMac/Features/Loop/Services/TestStructureDetector.swift`
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopOutputLayout.swift` — add after `docsIndex`:
  ```swift
  static let testDir = "llm-doc/loop/test"
  static let testStructureMD = "llm-doc/loop/test/TEST-STRUCTURE.md"
  static let testStructureJSON = "llm-doc/loop/test/TEST-STRUCTURE.json"
  static let testMapMD = "llm-doc/loop/test/TEST-MAP.md"
  static let testMapJSON = "llm-doc/loop/test/TEST-MAP.json"
  static let testLedger = "llm-doc/loop/test/ledger.json"
  ```
- Test: `mac/Tests/LlmIdeMacTests/TestStructureDetectorTests.swift`

**Interfaces (produces):**
```swift
public enum TestRunner: String, Codable { case xctest, nodeTest, npm, jest, pytest, goTest, cargo, make }
public struct TestRoot: Codable, Equatable {
    public var packageDir: String      // "" for repo root, "mac" for mac/Package.swift
    public var testDir: String         // "mac/Tests/LlmIdeMacTests", "extension/tests", "tests"
    public var runner: TestRunner
    public var command: String         // runnable from the repo root: "cd mac && swift test", "cd extension && npm test", "pytest"
    public var namingRule: String      // human text from TestSourceMapper.testFileName, e.g. "Foo.swift → FooTests.swift"
    public var languages: [String]     // ["swift"], ["mjs","js"] …
}
public struct TestStructure: Codable, Equatable {
    public var generatedAt: Date
    public var roots: [TestRoot]
    public var status: String          // "ok" | "missing"
    public var notes: [String]         // e.g. "Package.swift has no testTarget"
    public func testRoot(forSourcePath: String) -> TestRoot?   // longest packageDir prefix wins
    public func render() -> String     // TEST-STRUCTURE.md
}
struct TestStructureDetector {
    var gitRoot: URL
    func detect() -> TestStructure
    @discardableResult func write(_ s: TestStructure) throws -> URL   // writes MD + JSON under gitRoot/LoopOutputLayout.testDir
}
```
Detection rules (depth ≤ 2 below the git root, `excludedDirs` skipped):
- `Package.swift` containing `.testTarget(` → root with `testDir` = the first existing of `<pkg>/Tests/<Name>` where `<Name>` is the testTarget's `name:` (regex `\.testTarget\(\s*name:\s*"([^"]+)"`), command `cd <pkg> && swift test` (`swift test` when pkg is ""), runner `.xctest`. A `Package.swift` WITHOUT `.testTarget(` → note "Package.swift at <pkg> has no testTarget" and no root.
- `package.json` with a runnable `scripts.test` (reuse `LoopStageDetector.isRunnableNpmTestScript`) → `testDir` = first existing of `<pkg>/tests`, `<pkg>/test`, `<pkg>/__tests__`, `<pkg>/src/__tests__`; runner `.jest` when the script contains `jest`, else `.nodeTest`; command `cd <pkg> && npm test`. No test dir → note.
- `pytest.ini` / `pyproject.toml` or `setup.cfg` mentioning pytest → `testDir` = first existing of `<pkg>/tests`, `<pkg>/test`; runner `.pytest`; command `cd <pkg> && pytest`.
- `go.mod` → `.goTest`, testDir = packageDir (Go tests live beside sources), command `cd <pkg> && go test ./...`.
- `Cargo.toml` → `.cargo`, testDir `<pkg>/tests` if it exists else packageDir, command `cd <pkg> && cargo test`.
- `status` = "ok" when `roots` is non-empty, else "missing". Never creates directories.
- TEST-STRUCTURE.md: `# Test structure (<date>)`, `status: ok|missing`, then one `## <testDir>` section per root with `- runner:`, `- command:`, `- naming:`, `- languages:`, then `## Notes`, then `## Where a new test goes` with one line per root: "`<packageDir or .>/**/X.<ext>` → `<testDir>/<testFileName>`".

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class TestStructureDetectorTests: XCTestCase {
    private func make(_ files: [String: String]) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }
    func testDetectsSwiftAndNodeRootsAtDepthOne() throws {
        let root = try make([
            "mac/Package.swift": "let p = Package(targets: [.testTarget(name: \"AppTests\", dependencies: [])])",
            "mac/Tests/AppTests/ATests.swift": "import XCTest",
            "extension/package.json": "{\"scripts\":{\"test\":\"node --test tests/\"}}",
            "extension/tests/a.test.mjs": "test('x',()=>{})",
        ])
        let s = TestStructureDetector(gitRoot: root).detect()
        XCTAssertEqual(s.status, "ok")
        XCTAssertEqual(s.roots.map(\.testDir).sorted(), ["extension/tests", "mac/Tests/AppTests"])
        XCTAssertEqual(s.roots.first { $0.packageDir == "mac" }?.command, "cd mac && swift test")
        XCTAssertEqual(s.roots.first { $0.packageDir == "extension" }?.runner, .nodeTest)
        XCTAssertEqual(s.testRoot(forSourcePath: "mac/Sources/App/Foo.swift")?.testDir, "mac/Tests/AppTests")
        XCTAssertEqual(s.testRoot(forSourcePath: "extension/kb/db.mjs")?.testDir, "extension/tests")
    }
    func testMissingStructureIsReportedNotCreated() throws {
        let root = try make(["src/a.py": "def f(): pass", "mac/Package.swift": "let p = Package(targets: [.target(name: \"A\")])"])
        let s = TestStructureDetector(gitRoot: root).detect()
        XCTAssertEqual(s.status, "missing")
        XCTAssertTrue(s.notes.contains { $0.contains("no testTarget") })
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("tests").path))
    }
    func testWriteRendersPlacementRule() throws {
        let root = try make(["Package.swift": ".testTarget(name: \"XTests\")", "Tests/XTests/A.swift": ""])
        let d = TestStructureDetector(gitRoot: root)
        try d.write(d.detect())
        let md = try String(contentsOf: root.appendingPathComponent(LoopOutputLayout.testStructureMD), encoding: .utf8)
        XCTAssertTrue(md.contains("status: ok"))
        XCTAssertTrue(md.contains("Foo.swift → FooTests.swift") || md.contains("X.swift"))
        XCTAssertTrue(md.contains("Tests/XTests"))
    }
}
```
- [ ] **Step 2: Run to verify it fails.** - [ ] **Step 3: Implement** per the rules above (walk with `FileManager.enumerator` limited to depth 2 by counting path components; manifests found deeper are ignored).
- [ ] **Step 4: Run — 3 tests pass.** - [ ] **Step 5: Commit** — `git commit -m "feat(mac): detect the repo's test structure and write TEST-STRUCTURE.md"`

### Task 3: GraphIndex reader + TestMap builder (code graph → untested functions)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/Loop/Models/GraphIndex.swift`, `mac/Sources/LlmIdeMac/Features/Loop/Models/TestMap.swift`, `mac/Sources/LlmIdeMac/Features/Loop/Services/TestMapBuilder.swift`
- Test: `mac/Tests/LlmIdeMacTests/TestMapBuilderTests.swift`

**Interfaces:**
- Consumes: `TestSourceMapper` (Task 1), `TestStructure` (Task 2).
- `system/graph/graph.json` is written by `Features/CodeGraph/Notes/CodeNoteGenerator.writeGraphJSON` (`CodeNoteGenerator.swift:218-257`) at `ProjectLayout(root: repoRoot).graphDir/graph.json`, i.e. `<gitRoot>/system/graph/graph.json`, shape:
  ```json
  {"version":"1.0","summary":{"totalFiles":N,"totalEdges":N},
   "files":[{"path":"a/b.swift","name":"b.swift","language":"swift","loc":120,"role":"service",
             "imports":["a/c.swift"],"usedBy":["x/y.swift"],
             "types":[{"name":"B","line":3,"declaration":"struct B"}],
             "functions":[{"name":"run","line":10,"declaration":"func run()"}]}]}
  ```
- Produces:
  ```swift
  struct GraphIndex: Codable {
      struct Sym: Codable { var name: String; var line: Int; var declaration: String? }
      struct File: Codable { var path: String; var language: String; var loc: Int; var imports: [String]; var usedBy: [String]; var types: [Sym]; var functions: [Sym] }
      var version: String; var files: [File]
      static func load(gitRoot: URL) -> GraphIndex?    // nil when missing/undecodable
  }
  public struct TestMapEntry: Codable, Equatable { public var path: String; public var function: String; public var line: Int; public var fanIn: Int; public var loc: Int; public var testedBy: [String] }
  public struct TestMap: Codable, Equatable {
      public var generatedAt: Date; public var source: String       // "graph" | "files" (fallback)
      public var entries: [TestMapEntry]                              // every function, sorted untested-first by fanIn desc, loc desc, path, name
      public var untestedFunctions: Int; public var testedFunctions: Int; public var untestedFiles: Int
      public var counters: [String: Double]                           // the three above
      public func render(limit: Int = 40) -> String                   // TEST-MAP.md
      public static func delta(before: TestMap, after: TestMap) -> [String: Double]
  }
  struct TestMapBuilder {
      var gitRoot: URL; var structure: TestStructure
      func build() throws -> TestMap
      @discardableResult func write(_ map: TestMap) throws -> URL
  }
  ```
- "Tested" rule: collect the text of every file under every `structure.roots[].testDir` that `isTestPath` and `containsTestMarker`; function `f` of file `p` is tested when some test file in the root for `p` contains `f(` or `.f(` or `"f"` AND (`sourceStem(forTestPath:) == sourceStem(forSourcePath: p)` OR the test text contains the file's basename stem). `testedBy` lists those test paths. Functions named `init`, `deinit`, `body`, `main`, `description`, or starting with `_` are skipped. Fallback when `GraphIndex.load` is nil: entries are one per source file (`function: "*"`, `fanIn: 0`, `loc` from the file), tested by stem mapping; `source = "files"`.
- TEST-MAP.md: `# Test map (<source>, <date>)`, counters table, `## Untested functions (top 40 by fan-in)` as `- path:line function — fan-in N, file N lines`, `## Files with no test at all` (top 25), `## How to read` naming the counters and the rule.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class TestMapBuilderTests: XCTestCase {
    private func fixture() throws -> (URL, TestStructure) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let graph = """
        {"version":"1.0","summary":{"totalFiles":2,"totalEdges":1},"files":[
          {"path":"Sources/Core.swift","name":"Core.swift","language":"swift","loc":300,"role":"service","imports":[],"usedBy":["Sources/UI.swift","Sources/API.swift"],
           "types":[],"functions":[{"name":"parse","line":10,"declaration":"func parse()"},{"name":"render","line":40,"declaration":"func render()"},{"name":"init","line":1,"declaration":"init()"}]},
          {"path":"Sources/UI.swift","name":"UI.swift","language":"swift","loc":50,"role":"view","imports":["Sources/Core.swift"],"usedBy":[],
           "types":[],"functions":[{"name":"draw","line":5,"declaration":"func draw()"}]}]}
        """
        let files = ["system/graph/graph.json": graph,
                     "Sources/Core.swift": "", "Sources/UI.swift": "",
                     "Tests/AppTests/CoreTests.swift": "import XCTest\nfinal class CoreTests: XCTestCase { func testParse() { _ = Core().parse() } }\n"]
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        let structure = TestStructure(generatedAt: Date(), roots: [TestRoot(packageDir: "", testDir: "Tests/AppTests", runner: .xctest, command: "swift test", namingRule: "Foo.swift → FooTests.swift", languages: ["swift"])], status: "ok", notes: [])
        return (root, structure)
    }
    func testRanksUntestedByFanInAndSkipsInit() throws {
        let (root, s) = try fixture()
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.source, "graph")
        XCTAssertEqual(map.untestedFunctions, 2)      // render, draw
        XCTAssertEqual(map.testedFunctions, 1)        // parse
        XCTAssertEqual(map.entries.first?.function, "render"); XCTAssertEqual(map.entries.first?.fanIn, 2)
        XCTAssertEqual(map.entries.first { $0.function == "parse" }?.testedBy, ["Tests/AppTests/CoreTests.swift"])
        XCTAssertFalse(map.entries.contains { $0.function == "init" })
        XCTAssertEqual(map.untestedFiles, 1)          // UI.swift
    }
    func testFallsBackToFilesWithoutGraph() throws {
        let (root, s) = try fixture()
        try FileManager.default.removeItem(at: root.appendingPathComponent("system/graph/graph.json"))
        let map = try TestMapBuilder(gitRoot: root, structure: s).build()
        XCTAssertEqual(map.source, "files")
        XCTAssertEqual(map.untestedFiles, 1)
    }
    func testDeltaAndRender() throws {
        let (root, s) = try fixture()
        let b = TestMapBuilder(gitRoot: root, structure: s)
        let before = try b.build()
        try "final class UITests: XCTestCase { func testDraw() { UI().draw() } }".write(to: root.appendingPathComponent("Tests/AppTests/UITests.swift"), atomically: true, encoding: .utf8)
        let after = try b.build()
        XCTAssertEqual(TestMap.delta(before: before, after: after)["untestedFunctions"], -1)
        let md = after.render()
        XCTAssertTrue(md.contains("untestedFunctions")); XCTAssertTrue(md.contains("Sources/Core.swift:40 render"))
        try b.write(after)
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(LoopOutputLayout.testMapJSON).path))
    }
}
```
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: 3 tests pass.** - [ ] **Step 5: Commit** — `git commit -m "feat(mac): TestMap — rank untested functions from the code graph index"`

### Task 4: Ledger, single-test verify commands, and regression fault sync

**Files:**
- Create: `Features/Loop/Services/TestLedger.swift`, `Features/Loop/Services/VerifyCommandBuilder.swift`, `Features/Loop/Services/RegressionFaultSync.swift`
- Modify: `mac/Sources/LlmIdeMac/Core/Memory/MemoryStore.swift` — after `writeFault` add:
  ```swift
  /// Rewrite an existing fault file in place (status changes). Same YAML path as `writeFault`.
  func rewriteFault(at url: URL, _ fault: FaultReport) throws {
      try fault.toMarkdown().write(to: url, atomically: true, encoding: .utf8)
  }
  ```
- Tests: `TestLedgerTests.swift`, `VerifyCommandBuilderTests.swift`, `RegressionFaultSyncTests.swift`

**Interfaces:**
```swift
struct TestLedger: Codable, Equatable {
    var runId: String; var recordedAt: Date; var failing: [String]; var passing: [String]  // passing = ids seen passing (XCTest "passed" lines; others: empty)
    static func load(gitRoot: URL) -> TestLedger?
    func write(gitRoot: URL) throws
    struct Diff: Equatable { var newFailures: [String]; var stillFailing: [String]; var fixed: [String] }
    static func diff(previous: TestLedger?, currentFailing: [String], currentPassing: [String]) -> Diff
    // newFailures = currentFailing − previous.failing (ALL failing when previous is nil); fixed = previous.failing − currentFailing that are in currentPassing OR (currentFailing is empty and the run passed)
}
enum VerifyCommandBuilder {
    /// A command, runnable from the repo root, that runs ONLY `testId` with `runner` in `packageDir` ("" = root).
    static func command(runner: TestRunner, testId: String, packageDir: String, fallback: String) -> String
}
struct RegressionFaultSync {
    var gitRoot: URL; var store = MemoryStore()
    struct Outcome: Equatable { var created: [String]; var markedFixed: [String]; var skippedExisting: [String] }
    func apply(diff: TestLedger.Diff, root: TestRoot?, suiteCommand: String, gitHead: String?, appVersion: String) throws -> Outcome
}
```
`VerifyCommandBuilder` forms (ids come from `TestFailureExtractor`, `Core/Verification/TestFailureExtractor.swift`):
| runner | id example | command |
|---|---|---|
| xctest | `LlmIdeMacTests.FooTests/testBar` | `cd mac && swift test --filter 'FooTests/testBar'` (strip the module prefix before the first `.`) |
| nodeTest | `adds numbers` | `cd extension && node --test --test-name-pattern 'adds numbers' tests/` (testDir relative to packageDir) |
| jest | `adds numbers` | `cd pkg && npx jest -t 'adds numbers'` |
| pytest | `tests/test_x.py::test_a` | `cd pkg && pytest 'tests/test_x.py::test_a'` |
| goTest | `TestAdds` | `cd pkg && go test ./... -run '^TestAdds$'` |
| cargo, npm, make, unknown | any | `fallback` (the suite command) |
`cd <pkg> && ` is omitted when `packageDir` is empty; single quotes inside the id are escaped as `'\''`.

`RegressionFaultSync.apply`:
- For each `newFailures` id: tag `test:<id>`; if `store.listFaults(at:)` already has a fault with that tag whose status is `.open` or `.acknowledged` → `skippedExisting`. Else write `FaultReport(prompt: "Test regression: <id>", response: "", notes: "Found by the Test loop run. Verify runs only this test.", severity: .major, reportedAt: now, gitHead:, appVersion:, agent: "loop", status: .open, tags: ["regression", "test-loop", "test:<id>"], verify: VerifyCommandBuilder.command(...), verifyKind: .command)` → `created`.
- For each `fixed` id: every fault with tag `test:<id>` and status `.open`/`.acknowledged` → `status = .fixed`, `rewriteFault` → `markedFixed`.
- Match `FaultReport`'s real memberwise init (`Core/Memory/FaultReport.swift:50-75`); the fields above are all present there.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class VerifyCommandBuilderTests: XCTestCase {
    func testForms() {
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .xctest, testId: "LlmIdeMacTests.FooTests/testBar", packageDir: "mac", fallback: "x"), "cd mac && swift test --filter 'FooTests/testBar'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .pytest, testId: "tests/test_x.py::test_a", packageDir: "", fallback: "x"), "pytest 'tests/test_x.py::test_a'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .goTest, testId: "TestAdds", packageDir: "svc", fallback: "x"), "cd svc && go test ./... -run '^TestAdds$'")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .make, testId: "anything", packageDir: "", fallback: "make test"), "make test")
        XCTAssertEqual(VerifyCommandBuilder.command(runner: .jest, testId: "it's", packageDir: "", fallback: "x"), "npx jest -t 'it'\\''s'")
    }
}

final class TestLedgerTests: XCTestCase {
    func testDiff() {
        let prev = TestLedger(runId: "1", recordedAt: Date(), failing: ["A/t1", "A/t2"], passing: ["A/t3"])
        let d = TestLedger.diff(previous: prev, currentFailing: ["A/t2", "B/t9"], currentPassing: ["A/t1", "A/t3"])
        XCTAssertEqual(d.newFailures, ["B/t9"]); XCTAssertEqual(d.stillFailing, ["A/t2"]); XCTAssertEqual(d.fixed, ["A/t1"])
        XCTAssertEqual(TestLedger.diff(previous: nil, currentFailing: ["X/y"], currentPassing: []).newFailures, ["X/y"])
    }
    func testRoundTrip() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try TestLedger(runId: "r", recordedAt: Date(), failing: ["a"], passing: []).write(gitRoot: root)
        XCTAssertEqual(TestLedger.load(gitRoot: root)?.failing, ["a"])
    }
}

final class RegressionFaultSyncTests: XCTestCase {
    func testCreatesDedupesAndFixes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let sync = RegressionFaultSync(gitRoot: root)
        let xroot = TestRoot(packageDir: "", testDir: "Tests/T", runner: .xctest, command: "swift test", namingRule: "", languages: ["swift"])
        let first = try sync.apply(diff: .init(newFailures: ["T.FooTests/testBar"], stillFailing: [], fixed: []), root: xroot, suiteCommand: "swift test", gitHead: "abc", appVersion: "1")
        XCTAssertEqual(first.created, ["T.FooTests/testBar"])
        let faults = MemoryStore().listFaults(at: root)
        XCTAssertEqual(faults.count, 1)
        let f = try MemoryStore().loadFault(at: faults[0])
        XCTAssertEqual(f.verify, "swift test --filter 'FooTests/testBar'"); XCTAssertTrue(f.tags.contains("test:T.FooTests/testBar")); XCTAssertEqual(f.status, .open)
        let again = try sync.apply(diff: .init(newFailures: ["T.FooTests/testBar"], stillFailing: [], fixed: []), root: xroot, suiteCommand: "swift test", gitHead: nil, appVersion: "1")
        XCTAssertEqual(again.skippedExisting, ["T.FooTests/testBar"]); XCTAssertEqual(MemoryStore().listFaults(at: root).count, 1)
        let fixed = try sync.apply(diff: .init(newFailures: [], stillFailing: [], fixed: ["T.FooTests/testBar"]), root: xroot, suiteCommand: "swift test", gitHead: nil, appVersion: "1")
        XCTAssertEqual(fixed.markedFixed, ["T.FooTests/testBar"])
        XCTAssertEqual(try MemoryStore().loadFault(at: MemoryStore().listFaults(at: root)[0]).status, .fixed)
    }
}
```
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: All pass.** - [ ] **Step 5: Commit** — `git commit -m "feat(mac): test ledger, single-test verify commands, and regression→fault sync"`

### Task 5: `.testMap` stage kind + runner dispatch + test-write-only guard

**Files:**
- Modify: `Features/Loop/Models/LoopStage.swift`
  - `Kind`: add `case testMap` beside `artifactCheck` (line ~40).
  - Add `public enum TestMapOp: String, Codable { case structure, map, ledger }` and `public var testOp: TestMapOp? = nil` beside `check` (line ~132), decoded with `decodeIfPresent`, encoded with `encodeIfPresent`; memberwise `init` (line 144) gains `testOp: TestMapOp? = nil`.
  - `codeApplySkillIds` (lines 308-314): add `"skills/test-gap-writer"` and `"skills/test-structure-setup"`.
  - Add `public var testWriteOnly: Bool { kind == .skill && skillId == "skills/test-gap-writer" }`.
  - `verifies` (line ~319) unchanged: a `.testMap` stage never satisfies `lacksVerifyAfter`.
- Modify: `Features/Loop/Models/LoopDefinition.swift:73-81` `isManualOnly`: a code-apply stage counts only when `!stage.testWriteOnly`. (`test-structure-setup` still makes a loop manual-only while enabled — it edits manifests; it is enabled only when detection finds no runner, Task 7.)
- Modify: `Features/Loop/Models/LoopRunRecord.swift` `LoopStageAttempt`: add `public var testMapDelta: [String: Double]? = nil` and `public var newFaults: [String]? = nil` (`decodeIfPresent`, omitted when nil).
- Modify: `Features/Loop/Services/LoopEngineRunner.swift`
  - Dispatch: next to `case .artifactCheck` add `case .testMap: try await runTestMapStage(stage)`:
    - `.structure`: `TestStructureDetector(gitRoot:).detect()`, `write`, keep in `var testStructure: TestStructure?` for the run; log the roots table; `passed = true` always (the setup skill handles "missing"). Log `"no test structure found — the Setup stage will create one"` when status is missing.
    - `.map`: needs `testStructure` (re-detect if nil); `TestMapBuilder.build()`; `write`; store `var testMapBefore: TestMap?` the FIRST time in a run, `testMapAfter` on later calls; when both exist set `attempt.testMapDelta = TestMap.delta(before:after:)` and, if the run contained an enabled `testWriteOnly` stage that reported changed paths, fail the stage with `"Test Write changed files but untestedFunctions did not fall"` when `delta["untestedFunctions"] ?? 0 >= 0`. Otherwise pass.
    - `.ledger`: find the most recent attempt in this iteration whose `kind == .shellCommand && stage.verifies` (the Test stage); `TestFailureExtractor.extract(outputTail)` is NOT enough (4 KB) — use the stage's full captured output the runner already holds for `StageOutputParser` (locate via `/usr/bin/grep -n "parseFailureCount\|TestFailureExtractor.extract" LoopEngineRunner.swift` and keep the full text on the iteration state). Passing ids: XCTest `Test Case '-[M.C m]' passed` lines → `M.C/m`. `TestLedger.diff`, `RegressionFaultSync.apply(root: testStructure?.testRoot(forSourcePath:) of the first failing id's file if known else roots.first, suiteCommand: the Test stage command)`, write the new ledger, set `attempt.newFaults = outcome.created`, log created / fixed / skipped counts. Pass always (a failing suite already failed the Test stage; the ledger only records).
  - Test-write-only guard: after a `testWriteOnly` skill stage returns (where `changedPaths`/`createdPaths` from `LoopAgentResult` are read), compute `allowed = Set(testStructure.roots.map(\.testDir))`; every path in `changedPaths ∪ createdPaths` must have a prefix in `allowed` AND must be in `createdPaths` (never modified). On violation: `git checkout -- <modified>` / delete the created offenders via the existing scope-guard revert helpers (`withScopeGuard` / `RepairScopeGuard` in `LoopEngineRunner.swift:2061-2300`), fail the stage with `"Test Write may only create files under <roots>; reverted: <paths>"`. `effectivePolicy` (lines ~1950-1957) treats a `testWriteOnly` stage like a code-apply stage (`.warn`) so protected-path logging does not revert the new tests first.
  - UI: every exhaustive `switch` over `Kind` (icons, labels, stage editor): label "Test Map", symbol `point.3.connected.trianglepath.dotted`; editor shows `Picker("Operation")` Structure / Map / Ledger for `.testMap`.
- Test: `mac/Tests/LlmIdeMacTests/LoopStageTestMapKindTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageTestMapKindTests: XCTestCase {
    func testRoundTripAndNotAVerifier() throws {
        let s = LoopStage(name: "Test Map", kind: .testMap, order: 0, isDefault: true, defaultKey: "test-map", testOp: .map)
        let back = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(back.kind, .testMap); XCTAssertEqual(back.testOp, .map); XCTAssertFalse(back.verifies)
    }
    func testWriterIsCodeApplyButNotManualOnly() {
        let writer = LoopStage(name: "Test Write", kind: .skill, order: 1, skillId: "skills/test-gap-writer", targetPath: "x", outputPath: "y", isDefault: true, defaultKey: "test-write")
        XCTAssertTrue(writer.appliesCode); XCTAssertTrue(writer.testWriteOnly)
        let test = LoopStage(name: "Test", kind: .shellCommand, command: "swift test", order: 2, isDefault: true, defaultKey: "test")
        let loop = LoopDefinition(name: "Test", stages: [writer, test], config: LoopEngineDefaults.newConfig(), defaultKey: LoopDefaultLoopKey.test)
        XCTAssertFalse(loop.isManualOnly)
        let setup = LoopStage(name: "Test Setup", kind: .skill, order: 0, skillId: "skills/test-structure-setup", targetPath: "x", outputPath: ".", isDefault: true, defaultKey: "test-setup")
        XCTAssertTrue(LoopDefinition(name: "T", stages: [setup, test], config: LoopEngineDefaults.newConfig(), defaultKey: LoopDefaultLoopKey.test).isManualOnly)
    }
    func testAttemptFields() throws {
        var a = LoopStageAttempt(stageId: "x", stageName: "Ledger", kind: .testMap, severity: .blocking, startedAt: Date(), duration: 0, exitCode: nil, passed: true, outputTail: "")
        a.testMapDelta = ["untestedFunctions": -3]; a.newFaults = ["T.A/testB"]
        let back = try JSONDecoder().decode(LoopStageAttempt.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(back.testMapDelta?["untestedFunctions"], -3); XCTAssertEqual(back.newFaults, ["T.A/testB"])
    }
}
```
(Adjust `LoopDefinition` / `LoopStageAttempt` memberwise labels to the real ones in `LoopDefinition.swift` / `LoopRunRecord.swift:28-124`; the assertions are the contract.)

- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement** (build warning-clean on exhaustive switches). - [ ] **Step 4: Full suite green; `feature-boundaries.sh` exit 0.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): .testMap stage kind (structure/map/ledger) and the test-write-only guard"`

### Task 6: Kit — `test-structure-setup` and `test-gap-writer`

**Files (`.skills`, branch `feat/test-loop-skills`):** create both `SKILL.md`s, register in `registry.yaml` after `refactor-apply` with the same fields as its neighbours.

- [ ] **Step 1: `skills/test-structure-setup/SKILL.md`**

```markdown
---
name: test-structure-setup
description: Use when a repo has no test folder or no runnable test command — reads the Loop's TEST-STRUCTURE.md (status: missing) and creates the smallest working test layout for the languages present, one package per run. Never writes application code.
---

# Test Structure Setup

Create a working, conventional test layout where TEST-STRUCTURE.md reports `status: missing`. One package per run; stop when the Input reports `status: ok`.

**Announce at start:** "I'm using the test-structure-setup skill to create a test folder and runner."

## Locating the paths
1. Supplied paths win: `Input:` is `llm-doc/loop/test/TEST-STRUCTURE.md`; `Write output to:` is the repo root the layout is created under.
2. Resolve relative paths against the repo root first, then the project root (the directory holding `system/project.json`).

## Procedure
1. Read the Input. If `status: ok`, change nothing and say "Structure already present."
2. Pick ONE package from `## Notes` (the first note names it). By language:
   - **Swift package** (`Package.swift` without `.testTarget`): add `.testTarget(name: "<LibraryTarget>Tests", dependencies: ["<LibraryTarget>"])` to `targets:` and create `Tests/<LibraryTarget>Tests/<LibraryTarget>Tests.swift` with one real test of an existing public symbol (import with `@testable import <LibraryTarget>`).
   - **Node package** (`package.json` without a runnable `scripts.test`): set `"test": "node --test tests/"` and create `tests/<firstModule>.test.mjs` with `import { test } from 'node:test'; import assert from 'node:assert/strict';` and one real assertion on an exported function. Do not add dependencies.
   - **Python** (`.py` files, no pytest config): create `pytest.ini` with `[pytest]\ntestpaths = tests`, `tests/__init__.py`, and `tests/test_<firstmodule>.py` with one real assertion.
   - **Go** (`go.mod`): create `<pkg>/<first>_test.go` with one real `func TestX(t *testing.T)`.
3. The one test must exercise real behaviour of an existing function (read it first); never `assert true`.
4. Finish with one line `Created: <testDir> (<command>)`.

## Rules
- Only manifests, runner config and the new test file(s). Never edit application source.
- Never add a dependency or a network step. Never commit.
- A later Test Structure stage re-detects; if detection still says missing, say what else it needs in your reply.
```

- [ ] **Step 2: `skills/test-gap-writer/SKILL.md`**

```markdown
---
name: test-gap-writer
description: Use when a Test loop stage should add real tests for the untested functions of ONE source file — reads TEST-MAP.md (ranked by code-graph fan-in) and TEST-STRUCTURE.md (where tests go, how they are named), writes behaviour tests, never edits the source. One source file per run.
---

# Test Gap Writer

Add tests for the untested functions of exactly **one** source file per run, chosen from the code-graph ranking. Writes test files only; never edits the source under test, build config or existing tests.

**Announce at start:** "I'm using the test-gap-writer skill to add tests for one untested file."

## Locating the paths
1. Supplied paths win: `Input:` is `llm-doc/loop/test/TEST-MAP.md`; `Write output to:` is the repo root. Read `llm-doc/loop/test/TEST-STRUCTURE.md` next to the Input for placement and naming.
2. Resolve relative paths against the repo root first, then the project root.

## Procedure
1. Read both files. Under "Untested functions", take the first entry whose file is a plain code module — skip SwiftUI `View` files, entry points (`main.swift`, `server.mjs`, `App.tsx`), generated files, anything under `Resources/`. Collect EVERY untested function of that file (the map lists them; fan-in order). Say which file and why.
2. Read the file fully, and one existing test file from the matching test root (TEST-STRUCTURE.md "Where a new test goes") to copy its imports, naming and helpers.
3. Create the test file at exactly the path TEST-STRUCTURE.md gives for that source (`<testDir>/<name from the naming rule>`). If that file already exists, add a NEW file `<stem>GapTests.<ext>` (Swift) / `<stem>.gap.test.<ext>` (JS) / `test_<stem>_gap.py` (Python) instead; never modify an existing file.
4. Write one or more tests per untested function (3–8 total): assert outputs and state transitions; no mocks of the unit itself; no `XCTAssertTrue(true)`; each test must fail if the function body were replaced by a stub. For an async or throwing function, cover the success path and one error path.
5. Do not run the suite (the next stage does). Leave the tree building: a missing helper goes inside the new test file.
6. Finish with one line `Covered: <source path> (<function names>)`, or `Covered: none — <reason>` when every candidate is unsuitable.

## Rules
- One source file per run. Only NEW files under the test root — the Loop reverts anything else and fails the stage.
- Construction-only or constant-only tests do not count; test behaviour.
- Never commit.
```

- [ ] **Step 3: Register both; commit in `.skills`** — `git commit -m "feat(skills): test-structure-setup and test-gap-writer for the Test loop"`

### Task 7: The new Test loop (stages, detection gate, contract, template)

**Files:**
- Modify: `Features/Loop/Services/LoopStageDetector.swift`
  - Stage keys routed to `LoopDefaultLoopKey.test` in `stageKeyOwner` (~738-740): `test-structure`, `test-setup`, `test-map`, `test-write`, `test`, `test-ledger`.
  - Replace the `case LoopDefaultLoopKey.test:` body (lines ~1036-1039) with `testStages(gitRoot:)`:
    ```swift
    private static func testStages(gitRoot: URL) -> [LoopStage] {
        let command = detectTestCommand(gitRoot: gitRoot)
        var stages: [LoopStage] = [
            LoopStage(name: "Test Structure", kind: .testMap, order: 0, isDefault: true, defaultKey: "test-structure", testOp: .structure),
            LoopStage(name: "Test Setup", kind: .skill, order: 1, skillId: "skills/test-structure-setup",
                      targetPath: LoopOutputLayout.testStructureMD, outputPath: ".",
                      prompt: testSetupPrompt, isDefault: true, defaultKey: "test-setup",
                      enabled: command == nil, disabledByDetection: command == nil ? nil : true),
            LoopStage(name: "Test Map", kind: .testMap, order: 2, isDefault: true, defaultKey: "test-map", testOp: .map),
            LoopStage(name: "Test Write", kind: .skill, order: 3, skillId: "skills/test-gap-writer",
                      targetPath: LoopOutputLayout.testMapMD, outputPath: ".",
                      prompt: testWritePrompt, isDefault: true, defaultKey: "test-write"),
        ]
        if let command {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: command, order: 4,
                                    isDefault: true, defaultKey: "test", detectedCommand: command))
            stages.append(LoopStage(name: "Test Ledger", kind: .testMap, order: 5, isDefault: true, defaultKey: "test-ledger", testOp: .ledger))
            stages.append(LoopStage(name: "Test Map Check", kind: .testMap, order: 6, isDefault: true, defaultKey: "test-map-check", testOp: .map))
        } else {
            // No runner yet: the writer has nothing to verify against; it is disabled until detection returns.
            stages[3].enabled = false; stages[3].disabledByDetection = true
        }
        return stages
    }
    ```
    (The loop is no longer omitted when no command is detected — the Structure + Setup stages exist precisely for that case. Read the real `LoopStage` init to confirm `enabled`/`disabledByDetection` are init parameters; if `disabledByDetection` is set elsewhere, set it after construction.)
  - `revalidatingTestStages` (~1507-1570): when the test command appears, re-enable `test-setup` → disabled (`enabled = false`, since it is no longer needed) and `test-write` → enabled when they carry `disabledByDetection`; when it disappears, the reverse. Also pin the three verify-side stages (`test`, `test-ledger`, `test-map-check`) through the existing `ensureDefaultStages` path so a project that gains a runner later gets them.
  - Prompts (path-agnostic): `testSetupPrompt` = "Read the test-structure report at the Input. If it says the structure is missing, create the smallest working test folder and runner for ONE package under the Output path, following the repo's language conventions, with one real test; never edit application source and never add dependencies. If it says ok, change nothing." `testWritePrompt` = "Read the test map at the Input and the test-structure report next to it. Pick the first untested file that is a plain code module, read it, and create ONE new test file at the path the structure report gives, with real behaviour tests for every untested function listed for that file. Create files only under the test root; never edit the source, existing tests or build config. End with `Covered: <path>`."
  - Contract (`:1154-1156`): ("Keep the test suite green and growing: every run adds real tests for the most-used untested functions and records every new failure as a fault.", "The test command exits 0, untestedFunctions in TEST-MAP.md is lower than at the start of the run when Test Write ran, and every new failure has a fault with a runnable verify command.")
  - Detection (`detectTestCommandUncached`, 511-550): after pytest add `go.mod` → `go test ./...`, `Cargo.toml` → `cargo test`. `StageOutputParser`: add cargo `test result: ... (\d+) failed` → count.
  - `DefaultRevisionCatalog`: bump the `test` stage family to the next revision so saved Test loops are upgraded in place (existing `test` stage keeps its command; the new stages are pinned).
- Modify: `Features/Loop/Models/LoopTemplate.swift` — the Test template lists the same seven stages.
- Test: `mac/Tests/LlmIdeMacTests/LoopStageDetectorTestLoopTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorTestLoopTests: XCTestCase {
    func testOrderWithRunner() throws {
        let root = try TempRepo.make(files: ["Package.swift": "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"x\", targets: [.testTarget(name: \"XTests\")])\n"])
        let stages = LoopStageDetector.defaultStages(for: LoopDefaultLoopKey.test, gitRoot: root)
        XCTAssertEqual(stages.map(\.defaultKey), ["test-structure", "test-setup", "test-map", "test-write", "test", "test-ledger", "test-map-check"])
        XCTAssertEqual(stages[1].enabled, false)          // setup off: a runner exists
        XCTAssertEqual(stages[3].enabled, true)           // writer on
        XCTAssertEqual(stages[5].testOp, .ledger)
    }
    func testOrderWithoutRunner() throws {
        let root = try TempRepo.make(files: ["src/a.py": "def f(): return 1\n"])
        let stages = LoopStageDetector.defaultStages(for: LoopDefaultLoopKey.test, gitRoot: root)
        XCTAssertEqual(stages.map(\.defaultKey), ["test-structure", "test-setup", "test-map", "test-write"])
        XCTAssertEqual(stages[1].enabled, true); XCTAssertEqual(stages[3].enabled, false)
    }
    func testDetectsGoAndCargo() throws {
        XCTAssertEqual(LoopStageDetector.detectTestCommand(gitRoot: try TempRepo.make(files: ["go.mod": "module x\n"])), "go test ./...")
        XCTAssertEqual(LoopStageDetector.detectTestCommand(gitRoot: try TempRepo.make(files: ["Cargo.toml": "[package]\n"])), "cargo test")
    }
    func testScheduledLoopKeepsWriterButNotSetup() throws {
        let root = try TempRepo.make(files: ["Package.swift": "let p = Package(targets: [.testTarget(name: \"XTests\")])"])
        let loop = LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.test }!
        XCTAssertFalse(loop.isManualOnly)
    }
}
```
(`TempRepo.make`: reuse an existing temp-git-repo helper — `/usr/bin/grep -rl "git init" mac/Tests/LlmIdeMacTests | head` — else add a 15-line helper in `mac/Tests/LlmIdeMacTests/Support/TempRepo.swift` that writes the files and runs `git init -q`, `git add -A`, `git -c user.name=t -c user.email=t@t commit -qm init`. Use the real name of the per-loop stage entry point around `LoopStageDetector.swift:980-1040` if it is not `defaultStages(for:gitRoot:)`, and the real signature of `defaultLoops`.)

- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Full suite green; boundaries exit 0.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): Test loop — structure, setup, graph map, write, run, ledger, re-map"`

### Task 8: Summary, docs, changelog, kit pin, live check

**Files:** `Features/Loop/Services/LoopRunSummaryWriter.swift` (after the iterations table: `**Untested functions:** before → after` when any attempt has `testMapDelta`; `**New faults:** <ids>` when any has `newFaults`); `docs/explanation/loop-engineering.md` (Stages ~206: the `.testMap` kind and its three operations; Loops ~150: the Test loop's new row; a short "Regressions become faults" subsection after "Repairs cannot edit the verifier" ~370 naming the `test:<id>` tag and the verify command); `docs/spec/macos-app.md` Loop paragraph (~271-290: stage list, `llm-doc/loop/test/` layout, `testWriteOnly` guard, journal fields); `CHANGELOG.md`; llm-ide `.skills` gitlink.

- [ ] **Step 1:** Summary writer + a unit assertion in the existing `LoopRunSummaryWriter` tests (grep for them) that the two lines render.
- [ ] **Step 2:** Docs; `make docs-check` passes. Changelog entry with the downgrade note: builds before this read `.testMap` stages as unsupported and leave them untouched; saved Test loops are upgraded in place by revision.
- [ ] **Step 3:** After the user merges `.skills` `feat/test-loop-skills` to its main: `git add .skills`.
- [ ] **Step 4: Live check on llm-ide itself** (user runs in the app; implementer only states the expectation): Loop → Test → Run. Expected: `llm-doc/loop/test/TEST-STRUCTURE.md` lists `mac/Tests/LlmIdeMacTests` (`cd mac && swift test`) and `extension/tests` (`cd extension && npm test`) with `status: ok`; Test Setup is disabled; `TEST-MAP.md` ranks functions from `system/graph/graph.json` (source `graph`) — if it says `files`, the graph has not been generated for this repo yet (open the Graph page once); Test Write creates exactly one new `*Tests.swift` or `*.test.mjs`; Test passes; `ledger.json` exists; Test Map Check shows `untestedFunctions` lower than the first map.
- [ ] **Step 5: Commit** — `git commit -m "docs: Test loop upgrade — test map stage, regression faults, and the kit pin"`

## Self-review

- Spec coverage: test folder in the repo → Task 2 (detect) + Task 6/7 (setup when missing); code graph finds the functions → Task 3 (`graph.json` fan-in ranking, file fallback); generate related tests → Task 6/7 writer + Task 5 guard; structure for adding tests → `TEST-STRUCTURE.md` naming/placement (Tasks 1, 2) read by both skills; run tests → existing shell stage kept; find the regression and update correctly → Task 4 ledger + fault sync + Task 5 ledger op + Task 8 summary. Refactoring loop: deliberately untouched.
- Placeholder scan: every code step has code or an exact edit instruction; "match the real memberwise labels" notes are locating instructions with the contract fixed by assertions.
- Type consistency: `TestRunner`, `TestRoot`, `TestStructure.testRoot(forSourcePath:)`, `GraphIndex.load(gitRoot:)`, `TestMap.delta(before:after:)`, `TestLedger.diff(previous:currentFailing:currentPassing:)`, `VerifyCommandBuilder.command(runner:testId:packageDir:fallback:)`, `RegressionFaultSync.apply(diff:root:suiteCommand:gitHead:appVersion:)`, `LoopStage.testOp` / `testWriteOnly`, `LoopStageAttempt.testMapDelta` / `newFaults`, `LoopOutputLayout.test*` are used with the same names throughout.
