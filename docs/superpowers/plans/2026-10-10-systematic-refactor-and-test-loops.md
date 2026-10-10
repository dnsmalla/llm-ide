# Systematic Refactor + Test Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers use `model: sonnet`; reviewers use `model: fable`. Implementers never spawn sub-agents.

**Goal:** Make the Refactoring and Test loops *systematic*: every run measures the repo first, chooses what to change from those measurements, changes one batch, proves behaviour with the test suite, proves the measurement moved, and records all of it so the next run starts from evidence instead of a fresh guess.

**Architecture:** A new native stage kind `.metrics` (deterministic Swift, no LLM) writes `llm-doc/loop/metrics/METRICS.json` + `METRICS.md` and appends one line per run to `history.jsonl`. The same kind in `verify` mode re-measures after the apply + test stages and fails the run when the metric the batch promised to move did not move, or any metric regressed. `refactor-planner` reads METRICS.md and ranks batches by measured size, duplication and test gaps; each batch carries an `Expect:` line naming the metric it will move. A new manual-only **Test Coverage** loop uses a new `test-gap-writer` skill to add tests for the largest untested source file, verified by the same metrics check (untested count down, test-function count up, suite green). The journal records the batch id and the metric deltas; the run summary prints them.

**Tech Stack:** Swift/SwiftUI (`mac/`), the `.skills` kit (markdown skills + `registry.yaml`), existing Loop runner (`/kb/loop/agent-run` confined agent, `ArtifactCheckSpec`, `LoopRunJournal`).

**Spec (decided in this session, 2026-10-10 — the user asked for "a loop to make refactor and test more systematic"; these are the proposed decisions, each reversible):**
- **Measure before and after.** Metrics are computed natively, never by the model, so they cannot be gamed by prose. v1 metrics: file and line totals (source vs test), files over 500 lines, source files with no mapped test, number of test functions, and (llm-ide only, when `mac/Scripts/feature-boundaries.sh` exists) the count of cross-feature `warn` edges.
- **One batch per run, chosen by measure.** The planner orders batches by measured value (largest oversized file first, then largest untested file, then duplication), not by survey order. Each batch names the metric it will move.
- **The metric must move.** A refactor run passes only if the suite is green AND the batch's named metric improved AND no other metric regressed beyond tolerance (lines may grow by ≤2 % per run; counts may not grow).
- **Tests grow in their own loop.** Writing tests is a code-applying stage, which makes a loop manual-only, so it lives in a new **Test Coverage** loop and the scheduled **Test** loop stays as it is.
- **A test counts only if it is real.** A test file maps to a source only if it contains at least one test function marker; the metrics check also requires the suite's test total to rise.
- **Nothing is committed by the loop.** Unchanged: Run Changes review stays the human gate.
- **Not in v1:** coverage tools, mutation testing, code-graph fan-in ranking, "Level-4" cross-run suggestions. Listed in Phase 4 as follow-ups.

## Global Constraints

- Never push any repo. Commits only, on branches: llm-ide `feat/systematic-loops`, `.skills` `feat/metrics-and-test-gap`.
- Stage the `.skills` gitlink ONLY in the final integration commit (Task 10).
- Mac tests: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > $TMPDIR/mac-test.log 2>&1` (unsandboxed; `swift build` under the sandbox fails with "Invalid manifest"); assert the XCTest "Executed N tests, with 0 failures" line AND the swift-testing "✔ Test run with N tests" line. Never run two swift builds at once (`.build` lock).
- `mac/Scripts/feature-boundaries.sh` must still exit 0. Features never reference another feature; shared types go in `Core/`.
- Stage prompts are PATH-AGNOSTIC: refer to "the Input" / "the Output path"; the path lives only in `targetPath` / `outputPath`.
- New `LoopStage.Kind` cases decode as `.unsupported` on older builds (lenient Kind) — record the downgrade note in `CHANGELOG.md` (Task 10).
- `grep` is aliased to ugrep — use `/usr/bin/grep`. Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Conventional Commits, one concern per commit.
- Docs: `make docs-check` passes when `docs/` changes.

## File Structure

| Path | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/Features/Loop/Models/RepoMetrics.swift` | NEW. `RepoMetrics` (Codable snapshot), `RepoMetricsDelta`, `MetricsStageMode` (`snapshot` / `verify`), tolerance rules. Pure data + pure comparison. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/RepoMetricsCollector.swift` | NEW. Walks the repo, maps tests to sources, counts; writes JSON/MD/history. No LLM, no network. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/TestSourceMapper.swift` | NEW. Pure functions: is this path a test file, which source does it map to, does it contain a test marker. One place for every language rule. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopStage.swift` | MODIFY. Add `Kind.metrics`, `metricsMode: MetricsStageMode?`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner.swift` | MODIFY. Dispatch `.metrics` next to `.artifactCheck`; attach the snapshot/delta to the attempt. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopRunRecord.swift` | MODIFY. `LoopStageAttempt.batchId: String?`, `metricsDelta: [String: Double]?`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopStageDetector.swift` | MODIFY. Refactor loop gains Metrics (snapshot) first and Metrics Check (verify) last + a `refactor-plan-check` artifactCheck; new `testCoverage` loop. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopDefinition.swift` | MODIFY. `LoopDefaultLoopKey.testCoverage`, in `all` and `manualOnly`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopOutputLayout.swift` | MODIFY. `metricsDir`, `metricsJSON`, `metricsMD`, `metricsHistory`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopRunSummaryWriter.swift` | MODIFY. Print the batch id and the metric delta table. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopTemplate.swift` | MODIFY. Template for Test Coverage. |
| `.skills/skills/repo-metrics-reader/SKILL.md` | NEW. How a skill reads METRICS.md (shared text for the planner and the test-gap writer). |
| `.skills/skills/refactor-planner/SKILL.md` | MODIFY. Rank by metrics, `Expect:` line, fix the stale default path. |
| `.skills/skills/refactor-apply/SKILL.md` | MODIFY. Fix the stale default path; echo the applied batch id on its own line. |
| `.skills/skills/test-gap-writer/SKILL.md` | NEW. Pick the largest untested source from METRICS.md, write real tests. |
| `.skills/registry.yaml` | MODIFY. Register the two new skills. |
| `mac/Tests/LlmIdeMacTests/TestSourceMapperTests.swift` | NEW. |
| `mac/Tests/LlmIdeMacTests/RepoMetricsCollectorTests.swift` | NEW. Temp-dir fixtures. |
| `mac/Tests/LlmIdeMacTests/RepoMetricsDeltaTests.swift` | NEW. |
| `mac/Tests/LlmIdeMacTests/LoopStageDetectorMetricsTests.swift` | NEW. Stage lists for the two loops. |
| `docs/explanation/loop-engineering.md`, `docs/spec/macos-app.md` | MODIFY. New stage kind, new loop, the "metric must move" rule. |

---

## Phase 1 — Measure (Tasks 1–4)

### Task 1: TestSourceMapper (pure mapping rules)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/Loop/Services/TestSourceMapper.swift`
- Test: `mac/Tests/LlmIdeMacTests/TestSourceMapperTests.swift`

**Interfaces:**
- Produces:
  ```swift
  enum TestSourceMapper {
      static let excludedDirs: Set<String>   // .git node_modules .build dist build Pods DerivedData vendor .venv __pycache__ .llmide-loop-worktrees
      static func isTestPath(_ relPath: String) -> Bool
      /// The source basename (no extension) a test file is FOR, or nil.
      static func sourceStem(forTestPath relPath: String) -> String?
      /// The stem used to match a source file: "Foo+Bar.swift" → "Foo", "foo.mjs" → "foo".
      static func sourceStem(forSourcePath relPath: String) -> String?
      static func containsTestMarker(_ text: String) -> Bool
      static func isSourceCandidate(_ relPath: String) -> Bool   // code extensions only, not tests, not manifests
  }
  ```

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class TestSourceMapperTests: XCTestCase {
    func testSwiftTestFileMapsToStem() {
        XCTAssertTrue(TestSourceMapper.isTestPath("mac/Tests/LlmIdeMacTests/FooBarTests.swift"))
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "mac/Tests/LlmIdeMacTests/FooBarTests.swift"), "FooBar")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "Tests/X/FooBarTest.swift"), "FooBar")
    }
    func testSwiftExtensionFileSharesStem() {
        XCTAssertEqual(TestSourceMapper.sourceStem(forSourcePath: "mac/Sources/A/FooBar+History.swift"), "FooBar")
        XCTAssertEqual(TestSourceMapper.sourceStem(forSourcePath: "mac/Sources/A/FooBar.swift"), "FooBar")
    }
    func testJSAndPythonAndGoRules() {
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "extension/tests/vault.test.mjs"), "vault")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "src/__tests__/widget.tsx"), "widget")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "pkg/test_parser.py"), "parser")
        XCTAssertEqual(TestSourceMapper.sourceStem(forTestPath: "pkg/parser_test.go"), "parser")
        XCTAssertNil(TestSourceMapper.sourceStem(forTestPath: "src/widget.tsx"))
    }
    func testSourceCandidateExcludesTestsManifestsAndNoise() {
        XCTAssertTrue(TestSourceMapper.isSourceCandidate("extension/kb/db.mjs"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("extension/tests/db.test.mjs"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("mac/Package.swift"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("node_modules/x/index.js"))
        XCTAssertFalse(TestSourceMapper.isSourceCandidate("README.md"))
    }
    func testMarkers() {
        XCTAssertTrue(TestSourceMapper.containsTestMarker("final class A: XCTestCase { func testX() {} }"))
        XCTAssertTrue(TestSourceMapper.containsTestMarker("@Test func parses() {}"))
        XCTAssertTrue(TestSourceMapper.containsTestMarker("test('adds', () => {})"))
        XCTAssertTrue(TestSourceMapper.containsTestMarker("it('adds', () => {})"))
        XCTAssertTrue(TestSourceMapper.containsTestMarker("def test_adds():"))
        XCTAssertTrue(TestSourceMapper.containsTestMarker("func TestAdds(t *testing.T) {"))
        XCTAssertFalse(TestSourceMapper.containsTestMarker("// placeholder"))
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter TestSourceMapperTests > $TMPDIR/t.log 2>&1; /usr/bin/grep -E "error:|Executed" $TMPDIR/t.log | head`
Expected: compile error "cannot find 'TestSourceMapper'".

- [ ] **Step 3: Implement**

```swift
import Foundation

/// Every language rule for "which test file is FOR which source file" lives
/// here, so the metrics collector and the test-gap skill's contract agree.
enum TestSourceMapper {
    static let excludedDirs: Set<String> = [
        ".git", "node_modules", ".build", "dist", "build", "Pods", "DerivedData",
        "vendor", ".venv", "__pycache__", ".llmide-loop-worktrees", "monaco", "monaco-src",
    ]
    static let codeExtensions: Set<String> = ["swift", "mjs", "cjs", "js", "jsx", "ts", "tsx", "py", "go", "kt"]
    private static let manifests: Set<String> = ["Package.swift"]

    static func isSourceCandidate(_ relPath: String) -> Bool {
        let parts = relPath.split(separator: "/").map(String.init)
        guard let file = parts.last, !parts.dropLast().contains(where: { excludedDirs.contains($0) }) else { return false }
        guard let ext = file.split(separator: ".").last.map(String.init), codeExtensions.contains(ext) else { return false }
        if manifests.contains(file) { return false }
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
            if name.hasSuffix(".test") { return String(name.dropLast(5)) }
            if name.hasSuffix(".spec") { return String(name.dropLast(5)) }
            if dirs.contains("__tests__") { return name }
            if dirs.contains("tests") || dirs.contains("test") { return name }
            return nil
        case "py":
            if name.hasPrefix("test_") { return String(name.dropFirst(5)) }
            if name.hasSuffix("_test") { return String(name.dropLast(5)) }
            return nil
        case "go":
            return name.hasSuffix("_test") ? String(name.dropLast(5)) : nil
        case "kt":
            return name.hasSuffix("Test") ? String(name.dropLast(4)) : nil
        default: return nil
        }
    }

    static func sourceStem(forSourcePath relPath: String) -> String? {
        guard let file = relPath.split(separator: "/").last.map(String.init) else { return nil }
        let (name, _) = splitExt(file)
        return name.split(separator: "+").first.map(String.init)
    }

    static func containsTestMarker(_ text: String) -> Bool {
        let markers = ["func test", "@Test", "test(", "it(", "def test_", "func Test", "fun test", "@org.junit.Test"]
        return markers.contains { text.contains($0) }
    }

    private static func splitExt(_ file: String) -> (String, String) {
        guard let dot = file.lastIndex(of: ".") else { return (file, "") }
        return (String(file[..<dot]), String(file[file.index(after: dot)...]))
    }
}
```

- [ ] **Step 4: Run to verify it passes** — same command, expected "Executed 5 tests, with 0 failures".
- [ ] **Step 5: Commit** — `git add mac/Sources/LlmIdeMac/Features/Loop/Services/TestSourceMapper.swift mac/Tests/LlmIdeMacTests/TestSourceMapperTests.swift && git commit -m "feat(mac): TestSourceMapper — one place for test↔source mapping rules"`

### Task 2: RepoMetrics model + delta rules

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/Loop/Models/RepoMetrics.swift`
- Test: `mac/Tests/LlmIdeMacTests/RepoMetricsDeltaTests.swift`

**Interfaces:**
- Produces:
  ```swift
  public struct RepoMetrics: Codable, Equatable {
      public var schemaVersion: Int = 1
      public var generatedAt: Date
      public var commit: String?
      public var sourceFiles: Int
      public var testFiles: Int
      public var sourceLines: Int
      public var testLines: Int
      public var testFunctions: Int
      public var filesOver500: [FileLines]          // sorted desc by lines, max 50
      public var untestedSources: [FileLines]       // sorted desc by lines, max 100
      public var custom: [String: Int]              // e.g. "featureBoundaryWarnings"
      public struct FileLines: Codable, Equatable { public var path: String; public var lines: Int }
      /// Flat numbers the delta compares and the journal stores.
      public var counters: [String: Double]
  }
  public enum MetricsStageMode: String, Codable { case snapshot, verify }
  public struct RepoMetricsDelta: Equatable {
      public var changes: [String: Double]           // after − before, per counter
      public var regressions: [String]               // counters that got worse beyond tolerance
      public var expectedMoved: Bool?                 // nil when no expectation given
      public static func compare(before: RepoMetrics, after: RepoMetrics, expect: String?) -> RepoMetricsDelta
  }
  ```
- `counters` keys: `sourceFiles, testFiles, sourceLines, testLines, testFunctions, filesOver500Count, untestedSourcesCount` + every `custom` key.
- Direction: `testFiles`, `testFunctions` are "higher is better"; all others "lower is better". `sourceLines`/`testLines` tolerate +2 % growth; every count tolerates 0.
- `expect` is the metric name from a batch's `Expect:` line (e.g. `filesOver500Count`); `expectedMoved` is true when that counter improved strictly.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class RepoMetricsDeltaTests: XCTestCase {
    private func m(_ over: Int, untested: Int, lines: Int = 1000, tests: Int = 10) -> RepoMetrics {
        RepoMetrics(generatedAt: Date(), commit: nil, sourceFiles: 10, testFiles: 3, sourceLines: lines,
                    testLines: 100, testFunctions: tests, filesOver500: [], untestedSources: [], custom: [:],
                    filesOver500Count: over, untestedSourcesCount: untested)
    }
    func testExpectedCounterMustStrictlyImprove() {
        let d = RepoMetricsDelta.compare(before: m(5, untested: 9), after: m(4, untested: 9), expect: "filesOver500Count")
        XCTAssertEqual(d.expectedMoved, true); XCTAssertTrue(d.regressions.isEmpty)
        let same = RepoMetricsDelta.compare(before: m(5, untested: 9), after: m(5, untested: 9), expect: "filesOver500Count")
        XCTAssertEqual(same.expectedMoved, false)
    }
    func testCountRegressionIsFlagged() {
        let d = RepoMetricsDelta.compare(before: m(5, untested: 9), after: m(5, untested: 10), expect: nil)
        XCTAssertEqual(d.regressions, ["untestedSourcesCount"]); XCTAssertNil(d.expectedMoved)
    }
    func testLinesTolerateTwoPercent() {
        XCTAssertTrue(RepoMetricsDelta.compare(before: m(5, untested: 9, lines: 1000), after: m(5, untested: 9, lines: 1019), expect: nil).regressions.isEmpty)
        XCTAssertEqual(RepoMetricsDelta.compare(before: m(5, untested: 9, lines: 1000), after: m(5, untested: 9, lines: 1030), expect: nil).regressions, ["sourceLines"])
    }
    func testHigherIsBetterForTests() {
        XCTAssertEqual(RepoMetricsDelta.compare(before: m(5, untested: 9, tests: 10), after: m(5, untested: 9, tests: 9), expect: nil).regressions, ["testFunctions"])
        XCTAssertEqual(RepoMetricsDelta.compare(before: m(5, untested: 9, tests: 10), after: m(5, untested: 9, tests: 11), expect: "testFunctions").expectedMoved, true)
    }
    func testRoundTrip() throws {
        let data = try JSONEncoder().encode(m(1, untested: 2))
        XCTAssertEqual(try JSONDecoder().decode(RepoMetrics.self, from: data).filesOver500Count, 1)
    }
}
```

- [ ] **Step 2: Run to verify it fails** — compile error "cannot find 'RepoMetrics'".
- [ ] **Step 3: Implement** — `RepoMetrics` as a plain Codable struct with a memberwise `public init` whose parameters match the test's call exactly (`filesOver500Count` and `untestedSourcesCount` are stored, NOT computed, so a snapshot read from disk keeps the count even when the lists were capped). `counters` is a computed property. `RepoMetricsDelta.compare`:

```swift
public static func compare(before: RepoMetrics, after: RepoMetrics, expect: String?) -> RepoMetricsDelta {
    let higherIsBetter: Set<String> = ["testFiles", "testFunctions"]
    let tolerated: Set<String> = ["sourceLines", "testLines"]
    var changes: [String: Double] = [:]
    var regressions: [String] = []
    for (key, b) in before.counters {
        let a = after.counters[key] ?? b
        changes[key] = a - b
        let worse = higherIsBetter.contains(key) ? a < b : a > b
        let withinTolerance = tolerated.contains(key) && a <= b * 1.02
        if worse && !withinTolerance { regressions.append(key) }
    }
    var moved: Bool? = nil
    if let expect, let b = before.counters[expect], let a = after.counters[expect] {
        moved = higherIsBetter.contains(expect) ? a > b : a < b
    }
    return RepoMetricsDelta(changes: changes, regressions: regressions.sorted(), expectedMoved: moved)
}
```

- [ ] **Step 4: Run to verify it passes** — "Executed 5 tests, with 0 failures".
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): RepoMetrics snapshot model and delta rules"`

### Task 3: RepoMetricsCollector (walk, map, write)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Features/Loop/Services/RepoMetricsCollector.swift`
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopOutputLayout.swift` (add after `docsIndex`):
  ```swift
  static let metricsDir = "llm-doc/loop/metrics"
  static let metricsJSON = "llm-doc/loop/metrics/METRICS.json"
  static let metricsMD = "llm-doc/loop/metrics/METRICS.md"
  static let metricsHistory = "llm-doc/loop/metrics/history.jsonl"
  ```
- Test: `mac/Tests/LlmIdeMacTests/RepoMetricsCollectorTests.swift`

**Interfaces:**
- Consumes: `TestSourceMapper` (Task 1), `RepoMetrics` (Task 2).
- Produces:
  ```swift
  struct RepoMetricsCollector {
      var gitRoot: URL
      /// Pure: nothing written. Reads files only.
      func collect(commit: String?) throws -> RepoMetrics
      /// Writes METRICS.json, METRICS.md, appends history.jsonl under outputDir. Returns the written JSON URL.
      func write(_ metrics: RepoMetrics, to outputDir: URL, runId: String) throws -> URL
      static func render(_ metrics: RepoMetrics) -> String   // METRICS.md body
  }
  ```
- Mapping: build `[stem: [testPath]]` from every test file whose contents pass `containsTestMarker`; a source is "tested" when its `sourceStem(forSourcePath:)` has an entry. Files are listed via `git ls-files -z` when `.git` exists (respects .gitignore), else a `FileManager` walk skipping `excludedDirs`. Line counts: count `\n` in the data, no decoding needed. Files > 2 MB are skipped.
- `custom["featureBoundaryWarnings"]` is set only when `<gitRoot>/mac/Scripts/feature-boundaries.sh` exists: run it with `GroupedSubprocess` (the existing shell runner in this folder) and count lines starting with `warn`; on non-zero exit, omit the key (never fail the snapshot for it).
- METRICS.md: a header line `# Repo metrics (<commit>, <date>)`, a two-column table of every counter, `## Files over 500 lines` (top 25 as `- path — N lines`), `## Source files without a mapped test` (top 25 same form), and a final `## How to read` paragraph naming the counter keys verbatim so a skill can quote them in an `Expect:` line.

- [ ] **Step 1: Write the failing test** (temp fixture repo, no git):

```swift
import XCTest
@testable import LlmIdeMacLib

final class RepoMetricsCollectorTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let files: [String: String] = [
            "Sources/Big.swift": String(repeating: "let x = 1\n", count: 501),
            "Sources/Small.swift": "struct Small {}\n",
            "Sources/Small+Ext.swift": "extension Small {}\n",
            "Sources/Untested.swift": "struct Untested {}\n",
            "Tests/SmallTests.swift": "import XCTest\nfinal class SmallTests: XCTestCase { func testA() {} }\n",
            "Tests/UntestedTests.swift": "// empty placeholder, no test function\n",
            "node_modules/x/index.js": "module.exports = 1\n",
            "Package.swift": "// manifest\n",
        ]
        for (rel, body) in files {
            let url = root.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try body.write(to: url, atomically: true, encoding: .utf8)
        }
        return root
    }
    func testCollectCountsAndMaps() throws {
        let root = try fixture()
        let m = try RepoMetricsCollector(gitRoot: root).collect(commit: "abc1234")
        XCTAssertEqual(m.sourceFiles, 4)                 // Big, Small, Small+Ext, Untested (no manifest, no node_modules)
        XCTAssertEqual(m.testFiles, 1)                   // the placeholder has no marker
        XCTAssertEqual(m.testFunctions, 1)
        XCTAssertEqual(m.filesOver500.map(\.path), ["Sources/Big.swift"])
        XCTAssertEqual(m.filesOver500Count, 1)
        XCTAssertEqual(Set(m.untestedSources.map(\.path)), ["Sources/Big.swift", "Sources/Untested.swift"])
        XCTAssertEqual(m.untestedSourcesCount, 2)
        XCTAssertNil(m.custom["featureBoundaryWarnings"])
    }
    func testWriteProducesJSONMarkdownAndHistory() throws {
        let root = try fixture()
        let c = RepoMetricsCollector(gitRoot: root)
        let m = try c.collect(commit: nil)
        let out = root.appendingPathComponent("llm-doc/loop/metrics")
        _ = try c.write(m, to: out, runId: "run-1")
        _ = try c.write(m, to: out, runId: "run-2")
        XCTAssertTrue(FileManager.default.fileExists(atPath: out.appendingPathComponent("METRICS.json").path))
        let md = try String(contentsOf: out.appendingPathComponent("METRICS.md"), encoding: .utf8)
        XCTAssertTrue(md.contains("untestedSourcesCount"))
        XCTAssertTrue(md.contains("Sources/Big.swift — 501 lines"))
        let history = try String(contentsOf: out.appendingPathComponent("history.jsonl"), encoding: .utf8)
        XCTAssertEqual(history.split(separator: "\n").count, 2)
        XCTAssertTrue(history.contains("\"runId\":\"run-2\""))
    }
}
```

- [ ] **Step 2: Run to verify it fails** — compile error.
- [ ] **Step 3: Implement** per the interface above. History line shape: `{"runId":"…","generatedAt":"…","commit":"…","counters":{…}}` (encode a small private struct with `JSONEncoder` whose `outputFormatting` is `[.sortedKeys]`, append `"\n"`, open with `FileHandle(forWritingTo:)` + `seekToEnd`, create if missing).
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): RepoMetricsCollector writes METRICS.json/MD and a per-run history"`

### Task 4: `.metrics` stage kind in the runner

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopStage.swift` — add `case metrics` to `Kind` (next to `artifactCheck`, line ~40); add `public var metricsMode: MetricsStageMode? = nil` next to `check` (line ~132) with `decodeIfPresent` in `init(from:)` and `encodeIfPresent`; extend the memberwise `init` (line 144) with `metricsMode: MetricsStageMode? = nil`. `verifies` (line ~319) stays shell-only: a metrics check never satisfies `lacksVerifyAfter`. Add `var isBlockingMetricsVerify: Bool { kind == .metrics && metricsMode == .verify && severity != .advisory }`.
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopRunRecord.swift` — on `LoopStageAttempt` add `public var batchId: String? = nil` and `public var metricsDelta: [String: Double]? = nil` (both `decodeIfPresent`, omitted when nil, like `flaky`).
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner.swift` — find the `switch stage.kind` where `.artifactCheck` is executed (`/usr/bin/grep -n "case .artifactCheck" LoopEngineRunner.swift`) and add `.metrics` beside it, calling a new `runMetricsStage(_:)`:
  - `snapshot`: `RepoMetricsCollector(gitRoot:).collect(commit: shortHEAD)`, `write(to: gitRoot/LoopOutputLayout.metricsDir, runId:)`, store the snapshot in a per-run `var metricsBefore: RepoMetrics?`, log the counter table, attempt `passed = true`.
  - `verify`: collect again; `expect` = `self.currentExpect` (set by Task 6's plan-diff parse; nil in this task); `delta = RepoMetricsDelta.compare(before: metricsBefore ?? after, after:, expect:)`; write the new snapshot too (so history has before AND after); `passed = delta.regressions.isEmpty && (delta.expectedMoved ?? true)`; on failure log `"metrics regressed: \(regressions)"` or `"expected \(expect) to improve; it did not"`; attach `attempt.metricsDelta = delta.changes`. A failed blocking verify ends the iteration like a failed artifactCheck does (same path; it is not repairable — repairs are for shell stages — so the run reports `.failed` with that summary). When `metricsBefore` is nil (no snapshot stage in the loop) log "no snapshot in this run; comparing against itself" and pass.
  - Every metrics stage sets `attempt.kind = .metrics`, no exitCode, no score.
  - Update every exhaustive `switch` over `LoopStage.Kind` the compiler flags (UI icons/labels in `Views/`, `LoopStageEditor`, templates): label "Metrics", SF Symbol `chart.bar.doc.horizontal`. The stage editor shows a `Picker("Mode", selection: metricsMode)` with Snapshot / Verify when kind is `.metrics`.
- Test: `mac/Tests/LlmIdeMacTests/LoopStageMetricsKindTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageMetricsKindTests: XCTestCase {
    func testMetricsStageRoundTripsModeAndIsNotAVerifier() throws {
        let s = LoopStage(name: "Metrics", kind: .metrics, order: 0, isDefault: true, defaultKey: "metrics", metricsMode: .verify)
        let data = try JSONEncoder().encode(s)
        let back = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(back.kind, .metrics); XCTAssertEqual(back.metricsMode, .verify)
        XCTAssertFalse(back.verifies)
        XCTAssertTrue(back.isBlockingMetricsVerify)
    }
    func testAttemptCarriesBatchIdAndDelta() throws {
        var a = LoopStageAttempt(stageId: "x", stageName: "Metrics Check", kind: .metrics, severity: .blocking,
                                 startedAt: Date(), duration: 0, exitCode: nil, passed: false, outputTail: "")
        a.batchId = "R3"; a.metricsDelta = ["filesOver500Count": -1]
        let back = try JSONDecoder().decode(LoopStageAttempt.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(back.batchId, "R3"); XCTAssertEqual(back.metricsDelta?["filesOver500Count"], -1)
    }
}
```
(Match `LoopStageAttempt`'s real memberwise init — read `LoopRunRecord.swift:28-124` and adjust the labels in the test; the assertions are the contract.)

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** as described. Build must be warning-clean for exhaustive switches.
- [ ] **Step 4: Full test run** — `LLMIDE_KEYCHAIN_BACKEND=memory swift test` green; `mac/Scripts/feature-boundaries.sh` exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): .metrics stage kind (snapshot/verify) with per-attempt batch id and delta"`

## Phase 2 — Steer the Refactoring loop (Tasks 5–7)

### Task 5: Kit — metrics reader, planner ranks by measure, apply echoes the batch

**Files (in `.skills`, branch `feat/metrics-and-test-gap`):**
- Create: `skills/repo-metrics-reader/SKILL.md`
- Modify: `skills/refactor-planner/SKILL.md`, `skills/refactor-apply/SKILL.md`, `registry.yaml`

- [ ] **Step 1: Write `skills/repo-metrics-reader/SKILL.md`**

```markdown
---
name: repo-metrics-reader
description: Use when a loop stage needs the repo's measured state — oversized files, untested sources, test-function counts — from the Metrics stage's METRICS.md. Read-only; tells a planner or test writer which counter names exist and how to cite one.
---

# Repo Metrics Reader

The Loop's Metrics stage writes `llm-doc/loop/metrics/METRICS.md` (and `METRICS.json`) before any generate stage runs. It is the ONLY source of truth for "what is big" and "what is untested"; never estimate those by reading code.

## Counters (quote these names verbatim)
- `filesOver500Count` — source files over 500 lines (lower is better). The file list follows under "Files over 500 lines".
- `untestedSourcesCount` — source files with no mapped test file (lower is better). List under "Source files without a mapped test".
- `testFunctions` — test functions found (higher is better).
- `sourceLines`, `testLines`, `sourceFiles`, `testFiles` — totals; `sourceLines` may grow at most 2 % per run.
- `featureBoundaryWarnings` — present only in repos with a boundary gate (lower is better).

## Mapping rule (what makes a source "tested")
A test file maps to a source when its name matches the source's stem: `Foo.swift`/`Foo+Ext.swift` ↔ `FooTests.swift`; `x.mjs` ↔ `x.test.mjs` or `tests/x.mjs`; `x.py` ↔ `test_x.py`; `x.go` ↔ `x_test.go`. A test file counts only if it contains at least one test function.

## Citing a metric in a plan
Write `- Expect: <counterName> <before> → <after>` using a counter name above and the current value from METRICS.md. One counter per batch.
```

- [ ] **Step 2: Edit `refactor-planner/SKILL.md`**
  - In "Locating the paths": change the default Output to `llm-doc/loop/refactor/REFACTOR.md`; add: "**Metrics**: read `llm-doc/loop/metrics/METRICS.md` (relative to the repo root) if it exists — see `repo-metrics-reader` — before surveying. If it is missing, say so in the plan's frontmatter (`metrics: none`) and fall back to `wc -l`."
  - In "What to survey": replace "Files over 500 lines to split (`wc -l`)" with "Files listed under *Files over 500 lines* in METRICS.md, largest first".
  - In "Plan file contract": add `metrics: <commit from METRICS.md | none>` to the frontmatter and a required line per batch: `- Expect: <counterName> <before> → <after>` (one counter; `none` is allowed only for docs/setup batches such as CLAUDE.md).
  - In "Rules": replace "Ordered safest-first" with "**Ordered by measured value, then safety**: batches that reduce `filesOver500Count` or `featureBoundaryWarnings` come first, largest file first; docs/setup batches (Expect: none) go last. Within equal value, safest first."
- [ ] **Step 3: Edit `refactor-apply/SKILL.md`** — default plan path to `llm-doc/loop/refactor/REFACTOR.md`; in Procedure step 4 add: "Finish your reply with exactly one line `Applied: R<n>` (or `Applied: none`), so the loop can journal which batch ran."
- [ ] **Step 4: Register** in `registry.yaml` after `refactor-apply`: `- id: repo-metrics-reader`, `path: skills/repo-metrics-reader`, same fields as its neighbours. Run the kit's own check if one exists (`ls .skills/scripts`; otherwise `/usr/bin/grep -c "id: repo-metrics-reader" registry.yaml` → 1).
- [ ] **Step 5: Commit in `.skills`** — `git commit -m "feat(skills): repo-metrics-reader; refactor-planner ranks by METRICS.md with Expect lines"`

### Task 6: Refactoring loop stages + plan check + batch journaling

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopStageDetector.swift` `refactorStages` (lines 934-954) and the prompts (885-904), `LoopEngineRunner.swift`, `LoopRunSummaryWriter.swift`, `DefaultRevisionCatalog.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopStageDetectorMetricsTests.swift`

**Interfaces:**
- Refactor loop stage order (revision 3): `refactor-metrics` (`.metrics` snapshot) → `refactor-plan` → `refactor-plan-check` (`.artifactCheck`) → `refactor-apply` → `refactor-test` → `refactor-metrics-check` (`.metrics` verify). Without a test command: only metrics + plan + plan-check (plan-only, as today).
- `refactorPlanCheckSpec`: an `ArtifactCheckSpec` on the sibling `refactor-plan` stage's Output requiring: file exists, ≤250 lines, contains `/^### R\d+ .*\(status: (todo|done|skipped)\)/` at least once, and every `### R` section contains `- Expect:`. Build it the way `docCheckSpec` is built (read `ArtifactCheckSpec.swift` lines 29-end for the sibling-output rule type and the available predicates; if a "section must contain line" predicate does not exist, add `requiredLinePerSection: (header: String, line: String)?` to the spec with its own decode fallback and a unit test).
- Batch id: after `refactor-apply` returns, the runner reads the plan file, diffs status lines against the copy it read before the stage (store the pre-stage text in a local), and sets `attempt.batchId` to the first `R<n>` whose status changed; fall back to parsing an `Applied: R<n>` line from the agent reply. Store `self.currentExpect` from that batch's `Expect:` counter name for the verify stage.
- Prompt changes: `refactorPlanPrompt` adds "Read the metrics file next to the Output (llm-doc/loop/metrics/METRICS.md under the repo root) first and rank batches by measured value; every batch carries an Expect line naming the counter it will reduce." `refactorApplyPrompt` adds "End with one line `Applied: R<n>`."
- Summary writer: after the iterations table add `**Batch:** R<n>` when any attempt has `batchId`, and a `| metric | Δ |` table from the last attempt with `metricsDelta`.
- `DefaultRevisionCatalog`: add revision 3 for `refactor-plan` / `refactor-apply` (prompt text changed) so `upgradingDefaultRevisions` rewrites saved stages; new stages are pinned by `ensureDefaultStages` as today.

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorMetricsTests: XCTestCase {
    func testRefactorLoopOrderWithTests() throws {
        let root = try TempRepo.make(files: ["Package.swift": "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"x\")\n"])
        let keys = LoopStageDetector.defaultStages(for: LoopDefaultLoopKey.refactor, gitRoot: root).map(\.defaultKey)
        XCTAssertEqual(keys, ["refactor-metrics", "refactor-plan", "refactor-plan-check", "refactor-apply", "refactor-test", "refactor-metrics-check"])
        let stages = LoopStageDetector.defaultStages(for: LoopDefaultLoopKey.refactor, gitRoot: root)
        XCTAssertEqual(stages.first?.metricsMode, .snapshot)
        XCTAssertEqual(stages.last?.metricsMode, .verify)
    }
    func testRefactorLoopPlanOnlyWithoutTests() throws {
        let root = try TempRepo.make(files: ["README.md": "x"])
        let keys = LoopStageDetector.defaultStages(for: LoopDefaultLoopKey.refactor, gitRoot: root).map(\.defaultKey)
        XCTAssertEqual(keys, ["refactor-metrics", "refactor-plan", "refactor-plan-check"])
    }
    func testBatchIdParsedFromPlanDiff() {
        let before = "### R1 Split Big (status: todo)\n- Expect: filesOver500Count 5 → 4\n### R2 X (status: todo)\n"
        let after  = "### R1 Split Big (status: done)\n- Expect: filesOver500Count 5 → 4\n### R2 X (status: todo)\n"
        let parsed = RefactorPlanDiff.appliedBatch(before: before, after: after)
        XCTAssertEqual(parsed?.id, "R1"); XCTAssertEqual(parsed?.expect, "filesOver500Count")
        XCTAssertNil(RefactorPlanDiff.appliedBatch(before: before, after: before))
    }
}
```
(`TempRepo.make` — check `mac/Tests/LlmIdeMacTests` for an existing temp-git-repo helper via `/usr/bin/grep -rl "git init" mac/Tests | head`; reuse it, else add a 15-line helper that creates a temp dir, writes the files and runs `git init -q`, `git add -A`, `git -c user.name=t -c user.email=t@t commit -qm init`. Use the real entry point name for "default stages of one loop" from `LoopStageDetector` around line 980-1040 if it is not `defaultStages(for:gitRoot:)`.)

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — `RefactorPlanDiff` is a small pure enum in `Features/Loop/Services/RefactorPlanDiff.swift`:

```swift
enum RefactorPlanDiff {
    struct Applied: Equatable { var id: String; var expect: String? }
    static func appliedBatch(before: String, after: String) -> Applied? {
        let b = statuses(before), a = statuses(after)
        guard let id = a.keys.sorted(by: numeric).first(where: { b[$0] != nil && b[$0] != a[$0] }) else { return nil }
        return Applied(id: id, expect: expect(for: id, in: after))
    }
    private static func statuses(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        for line in text.split(separator: "\n") {
            guard line.hasPrefix("### R"), let open = line.range(of: "(status: "), let close = line.range(of: ")", range: open.upperBound..<line.endIndex) else { continue }
            let id = line.dropFirst(4).prefix { !$0.isWhitespace }
            out[String(id)] = String(line[open.upperBound..<close.lowerBound])
        }
        return out
    }
    private static func expect(for id: String, in text: String) -> String? {
        var inSection = false
        for line in text.split(separator: "\n") {
            if line.hasPrefix("### ") { inSection = line.hasPrefix("### \(id) ") }
            else if inSection, line.hasPrefix("- Expect: ") {
                let name = line.dropFirst("- Expect: ".count).prefix { !$0.isWhitespace }
                return name == "none" ? nil : String(name)
            }
        }
        return nil
    }
    private static func numeric(_ x: String, _ y: String) -> Bool { (Int(x.dropFirst()) ?? 0) < (Int(y.dropFirst()) ?? 0) }
}
```
Then the stage list, prompts, revision 3, the runner hook (read plan text before the apply stage, diff after, set `attempt.batchId` + `currentExpect`), and the summary writer additions.

- [ ] **Step 4: Full test run green; boundaries exit 0.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): Refactoring loop measures first, checks the plan shape, and verifies the batch's metric moved"`

### Task 7: Docs for Phase 1–2

**Files:** `docs/explanation/loop-engineering.md` (Stages section line ~206: the `.metrics` kind; a new subsection "The metric must move" after "Verification steers on a measured score" line ~303), `docs/spec/macos-app.md` Loop paragraph (~271-290: new stage order for Refactoring, `llm-doc/loop/metrics/` layout, journal fields `batchId` / `metricsDelta`). Fix the three drifts the audit found while there: default `consecutiveFailureStop` is 2 in `LoopEngineConfig` and 3 via `LoopEngineDefaults`; repairs use `/kb/loop/agent-run`, not `api.codeAssist`; detection also accepts `make regression`.

- [ ] **Step 1: Edit both docs.** - [ ] **Step 2: `make docs-check`** (unsandboxed) passes. - [ ] **Step 3: Commit** — `git commit -m "docs: metrics stage, the metric-must-move rule, and three Loop doc drifts"`

## Phase 3 — Grow tests (Tasks 8–9)

### Task 8: Kit — `test-gap-writer` skill

**Files (`.skills`):** Create `skills/test-gap-writer/SKILL.md`; register in `registry.yaml`.

- [ ] **Step 1: Write the skill**

```markdown
---
name: test-gap-writer
description: Use when a Test Coverage loop stage should add real tests for the largest source file that has none — reads METRICS.md, picks ONE file, writes tests that exercise its public behaviour, never touches the source. One file per run.
---

# Test Gap Writer

Add tests for exactly **one** untested source file per run, chosen from the Metrics stage's measurements. This skill writes test files only; it never edits the source under test, build config or existing tests.

**Announce at start:** "I'm using the test-gap-writer skill to add tests for one untested file."

## Locating the paths
1. Supplied paths win: `Input:` is the metrics file (`llm-doc/loop/metrics/METRICS.md`), `Write output to:` is the test directory root (e.g. `mac/Tests/LlmIdeMacTests`, `extension/tests`).
2. Resolve relative paths against the repo root first, then the project root (see refactor-planner).

## Procedure
1. Read the Input. Under "Source files without a mapped test", take the FIRST file that is a plain code module (skip: SwiftUI `View` files, entry points like `main.swift`/`server.mjs`, generated files, files under `Resources/`). Say which one and why.
2. Read that file fully, plus one existing test file in the Output directory to copy its conventions (imports, `@testable import LlmIdeMacLib`, naming, helpers).
3. Name the test file so it MAPS (see `repo-metrics-reader`): `Foo.swift` → `FooTests.swift`; `x.mjs` → `x.test.mjs`; `x.py` → `test_x.py`; `x.go` → `x_test.go`. Place it in the Output directory (or the sub-directory existing tests for that area use).
4. Write 3–8 tests of real behaviour, following `test-driven-development`'s anti-patterns file: assert outputs and state transitions, not that a function was called; no mocks of the unit itself; no `XCTAssertTrue(true)`; every test must fail if the function's body were replaced with a stub.
5. Do not run the suite (a later stage does). Leave the tree building: if the file needs a helper that does not exist, write it inside the test file.
6. Finish your reply with one line `Covered: <source path>`.

## Rules
- One source file per run. Never edit the source, other tests, manifests or CI.
- A test that only checks construction or a constant does not count; write behaviour.
- If every listed file is unsuitable, write nothing and finish with `Covered: none` and the reason.
```

- [ ] **Step 2: Register** in `registry.yaml`. - [ ] **Step 3: Commit in `.skills`** — `git commit -m "feat(skills): test-gap-writer — real tests for one untested file per run"`

### Task 9: Test Coverage loop + template + detection

**Files:**
- Modify: `LoopDefinition.swift:140-178` — add `static let testCoverage = "test-coverage"` to `LoopDefaultLoopKey`, append to `all` after `test`, add to `manualOnly`.
- Modify: `LoopStageDetector.swift` — route stage keys `coverage-metrics`, `coverage-write`, `coverage-test`, `coverage-metrics-check` in `stageKeyOwner` (near 738-740); new `testCoverageStages(gitRoot:)`: `.metrics` snapshot → `.skill` `skills/test-gap-writer` (targetPath `LoopOutputLayout.metricsMD`, outputPath = detected test dir: `mac/Tests/LlmIdeMacTests` when `Package.swift` has a test target, else `extension/tests` / `tests` / `test` whichever exists, else `.`) → `.shellCommand` test → `.metrics` verify. Loop omitted when no test command. Add `skills/test-gap-writer` to `codeApplySkillIds` (`LoopStage.swift:308-314`) so the loop is manual-only and `lacksVerifyAfter` protects it. Contract text: ("Add real tests for the untested source files, largest first, one file per run.", "The test suite passes, `untestedSourcesCount` fell by one, and `testFunctions` rose."). The verify stage's `expect` for this loop is fixed to `untestedSourcesCount` (set `currentExpect` from a per-loop default when no batch diff exists: add `static let fixedExpect: [String: String] = [LoopDefaultLoopKey.testCoverage: "untestedSourcesCount"]`).
- Modify: `detectTestCommandUncached` (`LoopStageDetector.swift:511-550`) — after pytest add `go.mod` → `go test ./...` and `Cargo.toml` → `cargo test`. `StageOutputParser` already parses `go test`; add `cargo test` failures: a line matching `test result: .* (\d+) failed` → that count.
- Modify: `LoopTemplate.swift` — add a "Test Coverage" template mirroring the stage list (follow how the Refactoring template is defined).
- Test: extend `LoopStageDetectorMetricsTests` with `testTestCoverageLoopOrder` (expects the four keys and `isManualOnly == true` for the built loop) and `testDetectsGoAndCargo`; add a `StageOutputParserTests` case for the cargo line.

- [ ] **Step 1: Write the failing tests** (same style as Task 6). - [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Full suite green; boundaries exit 0.**
- [ ] **Step 5: Commit** — `git commit -m "feat(mac): Test Coverage loop — measure, write tests for one untested file, verify, re-measure"`

### Task 10: Integration — kit pin, changelog, docs, live run

- [ ] **Step 1:** In llm-ide, `git add .skills` (gitlink only) after the `.skills` branch is merged to its `main` by the user; `CHANGELOG.md` entry: new `.metrics` stage kind + Test Coverage loop; **downgrade note**: builds before this read `.metrics` stages as unsupported and keep them untouched.
- [ ] **Step 2:** `docs/spec/macos-app.md` — Test Coverage loop row; `docs/explanation/loop-engineering.md` — Loops section row. `make docs-check` passes.
- [ ] **Step 3: Live run on llm-ide itself** (the user does this in the app, the implementer only prepares): open Loop → Refactoring → Run. Expected: `llm-doc/loop/metrics/METRICS.md` lists `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner.swift` (≈2,600 lines) and `LoopStageDetector.swift` (≈1,600) under "Files over 500 lines", `featureBoundaryWarnings: 46`; REFACTOR.md's R1 names one of them with `Expect: filesOver500Count`; after Apply + Test the Metrics Check passes only if that count dropped.
- [ ] **Step 4: Commit** — `git commit -m "chore: bump skills kit (metrics reader + test-gap writer) and document the systematic loops"`

## Phase 4 — Learn from runs (not scheduled; design only)

- **Trend line on the Loop page**: read `history.jsonl`, plot `filesOver500Count` and `untestedSourcesCount` per run (SwiftUI `Charts`). One file: `Features/Loop/Views/LoopMetricsTrendView.swift`.
- **Level-4 suggestions** (already listed as "deliberately not built" in loop-engineering.md): from the journal, per-stage pass rate, mean repairs to green, and batches most often `skipped` → an advisory `.skill` stage that proposes plan edits, never applies them.
- **Code-graph ranking**: when `FEATURE_GRAPH` is compiled in, weight untested files by fan-in from the code graph through a `Core/Contracts/GraphMetricsProviding` protocol so Loop never imports CodeGraph.
- **Coverage tools**: `swift test --enable-code-coverage` + `llvm-cov export` and `c8` for Node, as an optional `coverageLines` counter.

## Self-review

- Spec coverage: measure before/after (T3–T4), batch chosen by measure (T5–T6), metric must move (T2, T4, T6), tests grow in their own loop (T8–T9), real tests only (T1 markers + T9 `testFunctions` expectation), nothing committed (unchanged). Gaps: none in v1 scope; Phase 4 items are explicitly deferred.
- Placeholder scan: every code step has code or an exact edit; the two "match the real init" notes are locating instructions with the contract fixed by the assertions.
- Type consistency: `RepoMetrics`, `RepoMetricsDelta.compare(before:after:expect:)`, `MetricsStageMode`, `LoopStage.metricsMode`, `LoopStageAttempt.batchId/metricsDelta`, `RefactorPlanDiff.appliedBatch(before:after:)`, `LoopOutputLayout.metricsMD` are used with the same names throughout.
