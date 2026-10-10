# Premium Refactoring Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers use `model: haiku` (Haiku 5.5); reviewers use `model: fable`. A Haiku implementer that reports BLOCKED or reaches fix round 4 is re-dispatched on Sonnet. Implementers never spawn sub-agents.

**Goal:** Turn the Loop menu's **Refactoring** loop into a systematic, graph-verified pipeline: make sure every function the next batch will touch has a real test (generating the missing ones first), snapshot the code graph, plan and apply ONE behaviour-preserving batch toward a professional structure using that graph, then prove the result twice — the test suite is still green, and a fresh graph shows the structure actually improved and nothing regressed.

**Architecture:** Reuse the Test loop's native pieces (`.testMap` structure/map/ledger ops, `test-gap-writer`, the create-only guard, the failure ledger) and add one new native stage kind `.codeGraph` with `snapshot` and `verify` operations. `snapshot` asks the CodeGraph feature to rescan through a new `Core/Contracts/GraphRescanning` protocol (optional; falls back to the existing file), copies `system/graph/graph.json` to `llm-doc/loop/refactor/graph/before.json`, and renders `GRAPH.md` (modules, oversized files, fan-in, import/call cycles, llm-ide boundary warnings when the gate script exists, counters). `verify` rescans again after apply + test, writes `after.json` and `GRAPH-DELTA.md`, and fails the run when the batch's declared counter did not move or any structural counter regressed. The graph file gains **call edges** (today it has imports only, and none for Swift) so fan-in and cycles mean something for every language the scanner knows. The two refactor skills read `GRAPH.md` and `TEST-MAP.md`; each batch declares the files, symbols, missing tests and the counter it will move. A **baseline** test stage runs after the test-writing stage and before apply, with repair disabled, so a bad generated test can never trigger a source "repair".

**Tech Stack:** Swift/SwiftUI (`mac/`, Features/Loop + Features/CodeGraph + Core/Contracts + Shell/FeatureCatalog), the `.skills` kit (three skill edits), existing Loop runner.

**Spec (from the user, 2026-10-10):** "Refactor is already in the loop menu but I want it premium level. Use the existing code graph, the test loop and the structure skill. First check the test code; if it does not exist, generate test functions for all necessary ones so our check does not break. Then copy the code graph and, based on the graph, structure the existing code to a professional level and refactor, then check the tests to see whether it refactored correctly. Very heavy and very systematic." Decisions taken to implement that:
- **"All necessary" = every untested function in the files the next batch touches.** The batch is chosen first (plan), then tests are written for exactly its files (several files per run in this mode), then the suite must pass BEFORE the refactor (baseline). A baseline failure stops the run without repair.
- **"Copy the code graph" = a rescanned, timestamped snapshot** under `llm-doc/loop/refactor/graph/`, never the live file, so before/after are comparable and reviewable.
- **"Professional level" is measured, not asserted:** files ≤ 500 lines, no import/call cycles between files, bounded fan-in, one responsibility per file, consistent naming, explicit layering, dead code only when provably unreferenced, an AI-friendly root (CLAUDE.md/AGENTS.md, per-area README, entry-point index). The planner ranks batches by the graph counters and names the counter each batch moves; the verify stage checks it moved.
- **Behaviour preservation is proven by tests, structure by the graph.** Both must pass. Test failures after apply still go through the existing repair flow (apply stages run under `.warn`), AND are recorded as faults by the ledger stage.
- **Stays manual-only** (as today: a code-applying loop). One batch per run.
- **Out of scope:** language-specific AST refactoring tools, multi-repo projects, automatic commit.

## Global Constraints

- Never push any repo. Branches: llm-ide `feat/refactor-loop-premium`, `.skills` `feat/refactor-loop-skills`. Stage the `.skills` gitlink only in Task 8.
- Mac tests: `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test > $TMPDIR/mac-test.log 2>&1` with the Bash sandbox disabled for swift commands (sandboxed SwiftPM fails "Invalid manifest"); assert "Executed N tests, with 0 failures" AND "✔ Test run with N tests". Never two swift commands at once.
- Before any push: `mac/Scripts/feature-boundaries.sh` exit 0, `make docs-check`, AND `make loop-gates` (the loop-contract-lab executable is not part of `swift test` and asserts default-loop shapes).
- Layering: Features/Loop must not import GraphCore/GraphKit or anything under Features/CodeGraph; the rescan goes through `Core/Contracts/GraphRescanning`; Features/CodeGraph must not import Loop. Shell is the only place that wires them (`FeatureCatalog`, every `#if FEATURE_*` lives there).
- Stage prompts PATH-AGNOSTIC ("the Input" / "the Output path"). New `LoopStage.Kind` cases decode as `.unsupported` on older builds (downgrade note in CHANGELOG, Task 8).
- `grep` is aliased to ugrep — use `/usr/bin/grep`. Conventional Commits, one concern per commit, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Shipped Test-loop facts to build on (main cf4f88a7+): `TestMapOp {structure,map,ledger}`, `runTestMapStage`, `enforceTestWriteOnly` (records `writtenRoots`), `verifyIncludingWrittenRoots`, `flushFailureLedger`/`ledgerStage(after:in:)`, `RunContext.mainGitRoot`, `lastGuardSnapshot`, `LoopStage.testWriteOnly/isTestSetup/appliesCode/verifies/lacksVerifyAfter`, `codeApplySkillIds`, `TestMapBuilder(gitRoot:structure:)`, `TestMap.delta`, `TestStructure.testRoot(forSourcePath:)`, `GraphIndex.load(gitRoot:)`.

## File Structure

| Path | Responsibility |
|---|---|
| `mac/Sources/LlmIdeMac/Core/Contracts/GraphRescanning.swift` | NEW. `protocol GraphRescanning: AnyObject { func rescan(repoRoot: URL) async -> GraphRescanOutcome }`; `enum GraphRescanOutcome { case rewritten, busy, unavailable(String) }`. |
| `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/LoopGraphRescanner.swift` | NEW. `@MainActor final class LoopGraphRescanner: GraphRescanning` wrapping `CodeNoteService.generate(repoRoot:)`; one retry after 2 s on `.busy`. |
| `mac/Sources/LlmIdeMac/Shell/FeatureCatalog.swift` | MODIFY. `wireGraphRescanner()` (idempotent, `#if FEATURE_GRAPH && FEATURE_AUTOTASK`) called at the end of `bootGraph` and `bootAutoTask`; sets `graphRescanner` on `LoopRunService` and `LoopRunnerProvider`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopRunService.swift`, `LoopRunnerProvider.swift`, `LoopEngineRunner.swift` | MODIFY. Optional `graphRescanner: GraphRescanning?` threaded to `LoopEngineRunner.init`. |
| `mac/Sources/LlmIdeMac/Features/CodeGraph/Notes/CodeNoteGenerator.swift`, `CodeNoteService.swift` | MODIFY. `writeGraphJSON` also emits `calls: [{from, to, symbol}]` (file-level, from the in-memory `CGData` `.calls` edges) and bumps `version` to `"1.1"`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/GraphIndex.swift` | MODIFY. Decodes `calls` (default `[]`), `role`; `load(gitRoot:)` unchanged; `callers(of:)`/`callees(of:)` helpers. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/TestMapBuilder.swift` | MODIFY. fanIn = `usedBy ∪ distinct caller files` count; reads the graph from the MAIN root (worktree fix). |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/GraphReport.swift` | NEW. Pure: counters, cycles (Tarjan over imports ∪ calls), top lists, `render()` → GRAPH.md, `delta(before:after:expect:)` → `GraphDelta` + `renderDelta()`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/BoundaryWarningsProbe.swift` | NEW. Runs `mac/Scripts/feature-boundaries.sh` when it exists under the repo and parses `total: N`; nil otherwise. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/RefactorPlanDiff.swift` | NEW. Pure: which batch changed status between two plan texts, its `Expect:` counter and `Files:`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopStage.swift` | MODIFY. `Kind.codeGraph`, `graphOp: CodeGraphOp? (snapshot|verify)`, `allowsRepair: Bool = true` (decodeIfPresent), `isRefactorApply`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner+CodeGraph.swift` | NEW. `runCodeGraphStage`, snapshot/verify, batch-id capture after `refactor-apply`, `currentExpect`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopEngineRunner.swift` | MODIFY. Dispatch `.codeGraph`; honour `allowsRepair == false` (fail the run, no repair); per-run state reset. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/LoopRunRecord.swift` | MODIFY. `LoopStageAttempt.batchId: String?`, `graphDelta: [String: Double]?`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Models/ArtifactCheckSpec.swift` | MODIFY. `sectionRules: [SectionRule{headerPrefix, requiredLinePrefixes}]` (decodeIfPresent). |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopStageDetector.swift` | MODIFY. `refactorStages` revision 3 (11 stages with a runner), prompts v3, `refactorPlanCheckSpec`, routing keys, contract text, `legacyLoopContract(.refactor)`, revalidation of apply/baseline/test. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/LoopOutputLayout.swift` | MODIFY. `refactorDir`, `refactorGraphDir`, `refactorGraphBefore/After`, `refactorGraphMD`, `refactorGraphDelta`. |
| `mac/Sources/LlmIdeMac/Features/Loop/Services/DefaultRevisionCatalog.swift`, `Models/LoopTemplate.swift`, `Services/LoopRunSummaryWriter.swift` | MODIFY. Revision 3 history; "Refactoring" template parity; summary prints batch + graph delta. |
| `.skills/skills/refactor-planner/SKILL.md`, `refactor-apply/SKILL.md`, `test-gap-writer/SKILL.md` | MODIFY. Graph-driven planning; graph-aware apply; batch mode for the writer. |
| `mac/Tests/LlmIdeMacTests/{GraphReportTests, RefactorPlanDiffTests, GraphIndexCallsTests, LoopGraphRescannerTests, LoopStageCodeGraphKindTests, LoopStageDetectorRefactorLoopTests, ArtifactCheckSectionRulesTests}.swift` | NEW. |
| `mac/Sources/LoopContractLab/main.swift` | MODIFY if it asserts the Refactoring loop's shape (check first). |
| `docs/explanation/loop-engineering.md`, `docs/spec/macos-app.md`, `CHANGELOG.md` | MODIFY. |

---

### Task 1: GraphRescanning contract, CodeGraph adapter, Shell wiring

**Files:**
- Create: `mac/Sources/LlmIdeMac/Core/Contracts/GraphRescanning.swift`, `mac/Sources/LlmIdeMac/Features/CodeGraph/Services/LoopGraphRescanner.swift`
- Modify: `Shell/FeatureCatalog.swift` (after `bootGraph` ~62-80 and `bootAutoTask` ~391-477, following `wireMobileFeatureBridges` ~746-777), `Features/Loop/Services/LoopRunService.swift:~92-106`, `Features/Loop/Services/LoopRunnerProvider.swift:~38`, `Features/Loop/Services/LoopEngineRunner.swift:308-323` (init)
- Test: `mac/Tests/LlmIdeMacTests/LoopGraphRescannerTests.swift`

**Interfaces (produces):**
```swift
// Core/Contracts/GraphRescanning.swift
public enum GraphRescanOutcome: Equatable, Sendable { case rewritten, busy, unavailable(String) }
public protocol GraphRescanning: AnyObject {
    /// Regenerate <repoRoot>/system/graph/graph.json. Never throws; returns why it could not.
    func rescan(repoRoot: URL) async -> GraphRescanOutcome
}
// Features/CodeGraph/Services/LoopGraphRescanner.swift
@MainActor final class LoopGraphRescanner: GraphRescanning {
    init(service: CodeNoteService = CodeNoteService(), retryDelay: Duration = .seconds(2))
    func rescan(repoRoot: URL) async -> GraphRescanOutcome   // .success → .rewritten; .busy → sleep retryDelay, try once more; other errors → .unavailable(description)
}
```
- `LoopEngineRunner.init` gains `graphRescanner: GraphRescanning? = nil` stored as `let graphRescanner`. `LoopRunService` and `LoopRunnerProvider` gain `var graphRescanner: GraphRescanning?` and pass it to every runner they build.
- `FeatureCatalog.wireGraphRescanner()`: `#if FEATURE_GRAPH && FEATURE_AUTOTASK`, idempotent (guard `loopRunService?.graphRescanner == nil`), creates one `LoopGraphRescanner`, assigns to both; called at the end of `bootGraph` and `bootAutoTask` (boot order is Mobile → AutoTask → Graph, so the second call is the one that lands).

- [ ] **Step 1: Write the failing test** (a stub `CodeNoteService` is not injectable without the engine, so test the adapter through a protocol seam: give `LoopGraphRescanner` an `init(generate: @escaping (URL) async -> Result<Void, CodeNoteError>, retryDelay:)` used by the designated init.)

```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor final class LoopGraphRescannerTests: XCTestCase {
    func testSuccessIsRewritten() async {
        let r = LoopGraphRescanner(generate: { _ in .success(()) }, retryDelay: .zero)
        let out = await r.rescan(repoRoot: URL(fileURLWithPath: "/tmp/x"))
        XCTAssertEqual(out, .rewritten)
    }
    func testBusyRetriesOnceThenReportsBusy() async {
        var calls = 0
        let r = LoopGraphRescanner(generate: { _ in calls += 1; return .failure(.busy) }, retryDelay: .zero)
        let out = await r.rescan(repoRoot: URL(fileURLWithPath: "/tmp/x"))
        XCTAssertEqual(out, .busy); XCTAssertEqual(calls, 2)
    }
    func testBusyThenSuccessIsRewritten() async {
        var calls = 0
        let r = LoopGraphRescanner(generate: { _ in calls += 1; return calls == 1 ? .failure(.busy) : .success(()) }, retryDelay: .zero)
        XCTAssertEqual(await r.rescan(repoRoot: URL(fileURLWithPath: "/tmp/x")), .rewritten)
    }
    func testOtherFailureIsUnavailable() async {
        let r = LoopGraphRescanner(generate: { _ in .failure(.noEngine) }, retryDelay: .zero)
        if case .unavailable = await r.rescan(repoRoot: URL(fileURLWithPath: "/tmp/x")) {} else { XCTFail("expected unavailable") }
    }
    func testRunnerAcceptsNilRescanner() {
        // Compile-time contract: LoopEngineRunner.init(graphRescanner:) defaults to nil — construct via the existing test helper used in LoopEngineRunnerTests (grep `makeRunner`) and assert `runner.graphRescanner == nil`.
    }
}
```
(Use the real `CodeNoteError` cases — read `Features/CodeGraph/Notes/CodeNoteService.swift` top; `.busy` and `.noEngine` exist per the audit. This test file must be listed in `Package.swift`'s graph-excluded `testExcludes` (the `graphIncluded` branch ~line 45-52), because it imports a CodeGraph type.)

- [ ] **Step 2: Run** `cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test --filter LoopGraphRescannerTests` → compile error "cannot find 'LoopGraphRescanner'".
- [ ] **Step 3: Implement** the contract, adapter (designated init wraps `service.generate(repoRoot:)` mapping `Result<CGData, CodeNoteError>` to `Result<Void, CodeNoteError>`), runner/service/provider properties, and the FeatureCatalog wiring. `make build-mac-min` (graph excluded) must still build — the adapter file is under Features/CodeGraph so it is excluded with the feature, and the wiring is inside `#if FEATURE_GRAPH && FEATURE_AUTOTASK`.
- [ ] **Step 4: Run** the filtered tests, then the full suite; `feature-boundaries.sh` exit 0 (Loop never names `LoopGraphRescanner`; Shell may).
- [ ] **Step 5: Commit** — `feat(mac): GraphRescanning contract so the Loop can ask CodeGraph for a fresh graph`

### Task 2: Call edges in graph.json; GraphIndex decodes them; fan-in uses them; main-root reads

**Files:**
- Modify: `Features/CodeGraph/Notes/CodeNoteGenerator.swift:218-257` (`writeGraphJSON`) and its caller in `CodeNoteService.swift:~147-150` (pass the in-memory `CGData` or a pre-reduced `[FileCall]`), `Features/Loop/Models/GraphIndex.swift`, `Features/Loop/Services/TestMapBuilder.swift` (fanIn + read root), `Features/Loop/Services/LoopEngineRunner+TestMap.swift:~47-49` (pass `mainGitRoot` for the graph read)
- Test: `mac/Tests/LlmIdeMacTests/GraphIndexCallsTests.swift` (+ extend `TestMapBuilderTests` with one calls-based fan-in case)

**Interfaces:**
- `writeGraphJSON(scan:usedBy:calls:repoRoot:)` where `calls: [FileCall]`, `struct FileCall: Encodable { let from: String; let to: String; let symbol: String }` — derived from `CGData.edges` with `kind == .calls` whose `fromId`/`toId` resolve to symbol nodes in different files (use the node→file mapping the builder already has; if a node id does not resolve to a file, skip). Deduplicate `(from,to,symbol)`; sort. Top-level `"version": "1.1"`, `summary.totalCalls`.
- `GraphIndex.Call { from, to, symbol }`, `GraphIndex.calls: [Call]` (`decodeIfPresent ?? []`), `GraphIndex.File.role: String?` (optional), `func callerFiles(of path: String) -> Set<String>`, `func calleeFiles(of path: String) -> Set<String>`.
- `TestMapBuilder`: `fanIn = Set(file.usedBy).union(index.callerFiles(of: file.path)).count`. New init parameter `graphRoot: URL? = nil` — the directory whose `system/graph/graph.json` is read (defaults to `gitRoot`); `runTestMapStage` passes `mainGitRoot`.

- [ ] **Step 1: Failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class GraphIndexCallsTests: XCTestCase {
    func testDecodesCallsAndRole() throws {
        let json = """
        {"version":"1.1","summary":{"totalFiles":2,"totalEdges":0,"totalCalls":1},"files":[
          {"path":"A.swift","name":"A.swift","language":"swift","loc":10,"role":"Service","imports":[],"usedBy":[],"types":[],"functions":[{"name":"run","line":1}]},
          {"path":"B.swift","name":"B.swift","language":"swift","loc":10,"role":"View","imports":[],"usedBy":[],"types":[],"functions":[{"name":"draw","line":1}]}],
         "calls":[{"from":"B.swift","to":"A.swift","symbol":"run"}]}
        """
        let idx = try JSONDecoder().decode(GraphIndex.self, from: Data(json.utf8))
        XCTAssertEqual(idx.calls.count, 1)
        XCTAssertEqual(idx.callerFiles(of: "A.swift"), ["B.swift"])
        XCTAssertEqual(idx.calleeFiles(of: "B.swift"), ["A.swift"])
        XCTAssertEqual(idx.files[0].role, "Service")
    }
    func testOldGraphWithoutCallsStillDecodes() throws {
        let json = #"{"version":"1.0","files":[{"path":"A.swift","language":"swift","loc":1,"imports":[],"usedBy":[],"types":[],"functions":[]}]}"#
        XCTAssertEqual(try JSONDecoder().decode(GraphIndex.self, from: Data(json.utf8)).calls, [])
    }
}
```
Plus in `TestMapBuilderTests`: a fixture graph where `Core.swift` has `usedBy: []` but two `calls` from other files → its functions get `fanIn == 2`.
Plus a `CodeNoteGeneratorTests` case (if a test for `writeGraphJSON` exists, extend it; else add one) proving that a `CGData` with a `.calls` edge between symbols of two files yields one `calls` entry and `version == "1.1"`.

- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** - [ ] **Step 4: Full suite; boundaries exit 0.**
- [ ] **Step 5: Commit** (two commits: `feat(mac): graph.json 1.1 carries file-level call edges`; `fix(mac): Loop reads the graph from the main checkout and counts callers as fan-in`)

### Task 3: GraphReport (counters, cycles, render, delta) + BoundaryWarningsProbe

**Files:**
- Create: `Features/Loop/Models/GraphReport.swift`, `Features/Loop/Services/BoundaryWarningsProbe.swift`
- Test: `mac/Tests/LlmIdeMacTests/GraphReportTests.swift`

**Interfaces (produces):**
```swift
public struct GraphReport: Codable, Equatable {
    public var generatedAt: Date; public var commit: String?; public var graphVersion: String
    public var files: Int; public var totalLoc: Int
    public var filesOver500: [FileLoc]            // sorted loc desc, max 50
    public var cycles: [[String]]                  // file-level SCCs of size ≥ 2 over imports ∪ calls, each sorted, list sorted by size desc then first path, max 25
    public var topFanIn: [FileFanIn]               // (path, fanIn = usedBy ∪ callerFiles count), desc, max 25
    public var roles: [String: Int]                // role → count
    public var boundaryWarnings: Int?              // llm-ide only
    public var counters: [String: Double]          // filesOver500Count, cycleCount, filesInCycles, maxFanIn, avgLoc, totalLoc, boundaryWarnings (when present)
    public struct FileLoc: Codable, Equatable { public var path: String; public var lines: Int }
    public struct FileFanIn: Codable, Equatable { public var path: String; public var fanIn: Int }
    public static func build(from index: GraphIndex, commit: String?, boundaryWarnings: Int?) -> GraphReport
    public func render() -> String                 // GRAPH.md
    public static func delta(before: GraphReport, after: GraphReport, expect: String?) -> GraphDelta
}
public struct GraphDelta: Equatable {
    public var changes: [String: Double]; public var regressions: [String]; public var expectedMoved: Bool?
    public func render(batchId: String?) -> String // GRAPH-DELTA.md
}
struct BoundaryWarningsProbe { static func count(gitRoot: URL) async -> Int? }  // runs mac/Scripts/feature-boundaries.sh via GroupedSubprocess when it exists; parses the `total: N` line; nil on absence or failure
```
- Lower-is-better for every counter except none; tolerances: `totalLoc`/`avgLoc` may grow ≤ 2 %; all counts tolerate 0. `expectedMoved` is true when the named counter strictly decreased.
- GRAPH.md sections: `# Code graph (<version>, <commit>, <date>)`, counters table, `## Files over 500 lines`, `## Cycles` (each as `A → B → C → A`), `## Most depended-on files` (fan-in), `## Roles`, `## How to read` (counter names verbatim so the planner can cite them in `Expect:`).

- [ ] **Step 1: Failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class GraphReportTests: XCTestCase {
    private func index(_ json: String) throws -> GraphIndex { try JSONDecoder().decode(GraphIndex.self, from: Data(json.utf8)) }
    private let cyclic = """
    {"version":"1.1","files":[
      {"path":"a.mjs","language":"mjs","loc":600,"imports":["b.mjs"],"usedBy":["c.mjs"],"types":[],"functions":[]},
      {"path":"b.mjs","language":"mjs","loc":100,"imports":["c.mjs"],"usedBy":["a.mjs"],"types":[],"functions":[]},
      {"path":"c.mjs","language":"mjs","loc":100,"imports":["a.mjs"],"usedBy":["b.mjs"],"types":[],"functions":[]},
      {"path":"d.swift","language":"swift","loc":50,"imports":[],"usedBy":[],"types":[],"functions":[]}],
     "calls":[{"from":"d.swift","to":"a.mjs","symbol":"x"}]}
    """
    func testCountersCyclesAndFanIn() throws {
        let r = GraphReport.build(from: try index(cyclic), commit: "abc", boundaryWarnings: 46)
        XCTAssertEqual(r.filesOver500.map(\.path), ["a.mjs"])
        XCTAssertEqual(r.cycles, [["a.mjs", "b.mjs", "c.mjs"]])
        XCTAssertEqual(r.counters["cycleCount"], 1); XCTAssertEqual(r.counters["filesInCycles"], 3)
        XCTAssertEqual(r.topFanIn.first?.path, "a.mjs"); XCTAssertEqual(r.topFanIn.first?.fanIn, 2)   // usedBy c + caller d
        XCTAssertEqual(r.counters["boundaryWarnings"], 46); XCTAssertEqual(r.counters["maxFanIn"], 2)
    }
    func testNoCyclesWhenAcyclic() throws {
        let j = #"{"version":"1.1","files":[{"path":"a","language":"mjs","loc":1,"imports":["b"],"usedBy":[],"types":[],"functions":[]},{"path":"b","language":"mjs","loc":1,"imports":[],"usedBy":["a"],"types":[],"functions":[]}]}"#
        XCTAssertEqual(GraphReport.build(from: try index(j), commit: nil, boundaryWarnings: nil).cycles, [])
    }
    func testDeltaRules() throws {
        let before = GraphReport.build(from: try index(cyclic), commit: nil, boundaryWarnings: 46)
        var after = before; after.counters["cycleCount"] = 0; after.counters["filesInCycles"] = 0; after.counters["totalLoc"] = (before.counters["totalLoc"] ?? 0) * 1.01
        let d = GraphReport.delta(before: before, after: after, expect: "cycleCount")
        XCTAssertEqual(d.expectedMoved, true); XCTAssertTrue(d.regressions.isEmpty)
        var worse = before; worse.counters["filesOver500Count"] = 2
        XCTAssertEqual(GraphReport.delta(before: before, after: worse, expect: "cycleCount").regressions, ["filesOver500Count"])
        XCTAssertEqual(GraphReport.delta(before: before, after: worse, expect: "cycleCount").expectedMoved, false)
    }
    func testRenderNamesCountersAndCycles() throws {
        let md = GraphReport.build(from: try index(cyclic), commit: "abc", boundaryWarnings: nil).render()
        XCTAssertTrue(md.contains("cycleCount")); XCTAssertTrue(md.contains("a.mjs → b.mjs → c.mjs → a.mjs")); XCTAssertTrue(md.contains("## How to read"))
    }
}
```
- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement** (Tarjan's SCC over the adjacency `imports ∪ callees`; a self-loop alone is not a cycle). The probe reuses `GroupedSubprocess` (grep its signature in Features/Loop/Services) with a 120 s timeout.
- [ ] **Step 4: Pass; full suite.** - [ ] **Step 5: Commit** — `feat(mac): GraphReport — structural counters, cycles, fan-in and the delta rules`

### Task 4: `.codeGraph` stage kind, runner op, batch capture, baseline no-repair

**Files:**
- Modify: `Models/LoopStage.swift` (add `case codeGraph`; `public enum CodeGraphOp: String, Codable { case snapshot, verify }`; `public var graphOp: CodeGraphOp? = nil`; `public var allowsRepair: Bool = true` with `decodeIfPresent ?? true`; `var isRefactorApply: Bool { kind == .skill && skillId == "skills/refactor-apply" }`; init params), `Models/LoopRunRecord.swift` (`batchId: String?`, `graphDelta: [String: Double]?`), `Services/LoopEngineRunner.swift` (dispatch next to `.testMap` ~927; per-run state reset ~624-631; in `runShellStage` when a BLOCKING stage fails and `stage.allowsRepair == false`: skip flake gate and repair, record the attempt, terminate the run `.failed` with "stage <name> failed and does not allow repair"), `Services/LoopOutputLayout.swift` (add `refactorDir = "llm-doc/loop/refactor"`, `refactorGraphDir = "llm-doc/loop/refactor/graph"`, `refactorGraphBefore = ".../graph/before.json"`, `refactorGraphAfter = ".../graph/after.json"`, `refactorGraphMD = ".../GRAPH.md"`, `refactorGraphDelta = ".../GRAPH-DELTA.md"`), UI switches (`Views/NewLoopWizardView.swift`, `Views/LoopEngineView.swift`, `Views/LoopEngineView+DetailPane.swift`: label "Code Graph", symbol `point.topleft.down.to.point.bottomright.curvepath`, an Operation picker Snapshot/Verify, and a "Repairable" toggle shown for shell stages).
- Create: `Services/LoopEngineRunner+CodeGraph.swift`, `Services/RefactorPlanDiff.swift`
- Test: `LoopStageCodeGraphKindTests.swift`, `RefactorPlanDiffTests.swift`, one runner test for `allowsRepair == false`.

**Runner behaviour (`runCodeGraphStage`):**
- `snapshot`: `mainRoot = context.mainGitRoot ?? gitRoot`. If `graphRescanner != nil` → `await rescan(repoRoot: mainRoot)`; log the outcome; on `.unavailable`/`.busy` continue with the existing file if present. Load `GraphIndex` from `mainRoot/system/graph/graph.json`; if nil → when `graphRescanner == nil` log "code graph not available in this build; snapshot skipped" and PASS (advisory by nature); else FAIL "no graph.json after rescan". Copy the file to `mainRoot/LoopOutputLayout.refactorGraphBefore` (create dirs), `BoundaryWarningsProbe.count(gitRoot: mainRoot)`, `GraphReport.build`, write `refactorGraphMD`; keep `graphBefore: GraphReport?` per run. Pass.
- `verify`: rescan the same way; load; copy to `refactorGraphAfter`; build `after`; `delta = GraphReport.delta(before: graphBefore ?? after, after:, expect: currentExpect)`; write `refactorGraphDelta` (`delta.render(batchId: currentBatchId)`); `attempt.graphDelta = delta.changes`; FAIL when `!delta.regressions.isEmpty` ("structure regressed: …") or `delta.expectedMoved == false` ("batch <id> promised <counter> to fall; it did not"). When `graphBefore == nil` log and pass.
- Batch capture: before a stage with `isRefactorApply` runs, read the plan text at the stage's resolved Input (`LoopStagePaths` — grep how skill stages resolve `targetPath`); after it completes, read again, `RefactorPlanDiff.appliedBatch(before:after:)` → `attempt.batchId`, `currentBatchId`, `currentExpect` (per-run vars, reset per run); fall back to an `Applied: R<n>` line in the reply.
- `RefactorPlanDiff` (pure): `struct Applied { id, expect: String?, files: [String] }`; `static func appliedBatch(before: String, after: String) -> Applied?`; `static func firstTodo(in text: String) -> Applied?` (id, expect, files of the first `(status: todo)` batch — used by Task 7's prompts via the runner's `Input` for the test writer: the runner writes `llm-doc/loop/refactor/NEXT-BATCH.md` containing that batch's section verbatim before the writer stage, so the writer's Input is a small file, not the whole plan). Batch section grammar is the planner's: `### R<n> <title>  (status: todo|done|skipped)`, `- Files: \`a\`, \`b\``, `- Symbols: …`, `- Tests: present | missing \`...\``, `- Intent:`, `- Risk:`, `- Expect: <counter> <before> → <after>`.

- [ ] **Step 1: Failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageCodeGraphKindTests: XCTestCase {
    func testRoundTrip() throws {
        let s = LoopStage(name: "Graph", kind: .codeGraph, order: 0, isDefault: true, defaultKey: "refactor-graph", graphOp: .snapshot)
        let b = try JSONDecoder().decode(LoopStage.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(b.kind, .codeGraph); XCTAssertEqual(b.graphOp, .snapshot); XCTAssertFalse(b.verifies); XCTAssertTrue(b.allowsRepair)
    }
    func testAllowsRepairDecodesAbsentAsTrue() throws {
        let json = #"{"id":"x","name":"T","kind":"shellCommand","command":"swift test","order":0}"#
        XCTAssertTrue(try JSONDecoder().decode(LoopStage.self, from: Data(json.utf8)).allowsRepair)
    }
    func testAttemptFields() throws {
        var a = LoopStageAttempt(stageId: "x", stageName: "Graph Check", kind: .codeGraph, severity: .blocking, startedAt: Date(), duration: 0, exitCode: nil, passed: true, outputTail: "")
        a.batchId = "R2"; a.graphDelta = ["cycleCount": -1]
        let b = try JSONDecoder().decode(LoopStageAttempt.self, from: JSONEncoder().encode(a))
        XCTAssertEqual(b.batchId, "R2"); XCTAssertEqual(b.graphDelta?["cycleCount"], -1)
    }
}

final class RefactorPlanDiffTests: XCTestCase {
    let plan = """
    ### R1 Split Big  (status: todo)
    - Files: `Sources/Big.swift`, `Sources/BigHelpers.swift`
    - Symbols: `Big.run`, `Big.parse`
    - Tests: missing `Sources/Big.swift`
    - Intent: split
    - Risk: low
    - Expect: filesOver500Count 3 → 2
    ### R2 Break cycle  (status: todo)
    - Files: `a.mjs`
    - Expect: cycleCount 1 → 0
    """
    func testFirstTodo() {
        let b = RefactorPlanDiff.firstTodo(in: plan)
        XCTAssertEqual(b?.id, "R1"); XCTAssertEqual(b?.expect, "filesOver500Count"); XCTAssertEqual(b?.files, ["Sources/Big.swift", "Sources/BigHelpers.swift"])
    }
    func testAppliedBatch() {
        let after = plan.replacingOccurrences(of: "R1 Split Big  (status: todo)", with: "R1 Split Big  (status: done)")
        XCTAssertEqual(RefactorPlanDiff.appliedBatch(before: plan, after: after)?.id, "R1")
        XCTAssertNil(RefactorPlanDiff.appliedBatch(before: plan, after: plan))
    }
}
```
(Match the real `LoopStageAttempt`/`LoopStage` memberwise labels.) Runner test: a blocking shell stage with `allowsRepair = false` that fails → run status `.failed`, no repair attempted (StubRepairer call count 0), message contains "does not allow repair".

- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement.** Build warning-clean across the UI switches. - [ ] **Step 4: Full suite; boundaries exit 0.**
- [ ] **Step 5: Commit** (two: `feat(mac): .codeGraph stage kind (snapshot/verify) with the graph delta on the attempt`; `feat(mac): stages can refuse repair; refactor batch capture`)

### Task 5: ArtifactCheckSpec section rules + refactor plan check

**Files:**
- Modify: `Models/ArtifactCheckSpec.swift` (add `public struct SectionRule: Codable, Equatable { var headerPrefix: String; var requiredLinePrefixes: [String] }`, `var sectionRules: [SectionRule] = []` with `decodeIfPresent`), the evaluator `ArtifactCheckEvaluator.evaluate` (for each rule: every section starting with a line that has `headerPrefix` must contain, before the next `### `, a line starting with each required prefix; failure string names the section header and the missing prefix), `Services/LoopStageDetector.swift` (`refactorPlanCheckSpec`: `outputRules` on the sibling `refactor-plan` stage, file shape, `maxLines: 250`; `sectionRules: [SectionRule(headerPrefix: "### R", requiredLinePrefixes: ["- Files:", "- Expect:", "- Tests:"])]`).
- Test: `ArtifactCheckSectionRulesTests.swift` (section missing `- Expect:` → one failure naming `R2`; all present → none; a file with no `### R` sections → none).
- [ ] Steps 1-5 as above. Commit — `feat(mac): artifact checks can require lines per section; refactor plan check`

### Task 6: Kit — refactor-planner v3, refactor-apply v3, test-gap-writer batch mode

**Files (`.skills`, branch `feat/refactor-loop-skills`):** `skills/refactor-planner/SKILL.md`, `skills/refactor-apply/SKILL.md`, `skills/test-gap-writer/SKILL.md`; bump each `version` in `registry.yaml` to `1.1.0`.

- [ ] **Step 1: refactor-planner** — replace "Locating the paths" defaults with `llm-doc/loop/refactor/REFACTOR.md`; add **Inputs** section: "Read `llm-doc/loop/refactor/GRAPH.md` (the Loop's Code Graph snapshot: counters, files over 500 lines, cycles, most-depended-on files, roles) and `llm-doc/loop/test/TEST-MAP.md` (which functions have tests) before surveying. If GRAPH.md is missing, say `graph: none` in the frontmatter and fall back to `wc -l`." Replace "What to survey" with the **professional-structure criteria**: (1) files over 500 lines → split along responsibility seams; (2) import/call cycles → break by extracting the shared piece downward; (3) files with the highest fan-in that mix roles → separate; (4) one responsibility per file, named for what it does; (5) explicit layering (lower layers never import upper); (6) duplicated logic → one owner; (7) dead code only when provably unreferenced (grep incl. strings/configs/tests); (8) AI-friendly root: CLAUDE.md/AGENTS.md, per-area README, entry-point index, module-boundary rules. Batch contract gains `- Symbols:` (types/functions moved or split), `- Tests: present | missing \`path\` …` (from TEST-MAP.md: list source files in the batch with untested functions), `- Expect: <counter> <before> → <after>` using a GRAPH.md counter name verbatim (`filesOver500Count`, `cycleCount`, `filesInCycles`, `maxFanIn`, `boundaryWarnings`; `none` only for docs/setup batches). **Ordering**: by measured value — cycles first (highest `filesInCycles` gain), then oversized files (largest first), then fan-in/role mixing, then naming/docs; within equal value, safest first. Keep diff-first update, stable IDs, ≤ 10 files per batch, ≤ 250 lines.
- [ ] **Step 2: refactor-apply** — default plan path fix; **Inputs**: "Before moving or splitting, read GRAPH.md's cycle and fan-in entries for the batch's files and the `calls`/`usedBy` lists in `llm-doc/loop/refactor/graph/before.json` to find every dependant; update each import/reference you find there AND by grep." Add: "After the batch, every symbol listed under `- Symbols:` must still exist (moved is fine; renamed only if the Intent says so). Build-config references to moved paths (Package.swift excludes, feature maps, scripts, CI) must be updated — list them under the batch's Files in the plan when you touch them." Keep: first todo batch only, mark done/skipped, never commit. End with `Applied: R<n>` (or `Applied: none`).
- [ ] **Step 3: test-gap-writer** — add a **Batch mode** section: "When the Input is `llm-doc/loop/refactor/NEXT-BATCH.md` (one refactor batch), cover EVERY source file listed under `- Tests: missing` in that batch: for each, write a new test file at the path TEST-STRUCTURE.md gives, with behaviour tests for each of its untested functions as listed in TEST-MAP.md (characterisation tests: pin the current outputs so a refactor that changes behaviour fails). Several files per run are expected in this mode; the one-file rule applies only to the Test loop's map mode. Finish with one `Covered:` line per file." Keep every other rule (create-only, no source edits).
- [ ] **Step 4:** `bash scripts/validate.sh` (kit) passes; commit in `.skills` — `feat(skills): graph-driven refactor planner/apply and batch-mode test writer`

### Task 7: The premium Refactoring loop (stages, gating, contract, template, revision, summary)

**Files:**
- Modify: `Services/LoopStageDetector.swift` (`refactorStages`, prompts, routing, `unconditionalStageKeys`, contract, `legacyLoopContract(.refactor)` + `contractGateStageKey[refactor] = "refactor-graph"`, `revalidatingTestStages` for `refactor-test-baseline` and `refactor-test` and `refactor-apply`), `Services/DefaultRevisionCatalog.swift` (revision 3 for `refactor-plan`/`refactor-apply`, revision 2 for `refactor-test`; history entries), `Models/LoopTemplate.swift` (`refactoring` template = the same stages, placeholders for the two shell commands), `Services/LoopRunSummaryWriter.swift` (`**Batch:** R<n>` and a `| counter | Δ |` table from the last `graphDelta`), `mac/Sources/LoopContractLab/main.swift` if it asserts the refactor shape (grep `refactor`).
- Test: `LoopStageDetectorRefactorLoopTests.swift`; extend `LoopRunSummaryWriterTests`.

**Stage list, with a runner (order = index):**
1. `refactor-structure` — `.testMap` structure
2. `refactor-setup` — skill `skills/test-structure-setup`, enabled only when no runner (`disabledByDetection` as in the Test loop)
3. `refactor-structure-check` — `.testMap` structure
4. `refactor-graph` — `.codeGraph` snapshot
5. `refactor-test-map` — `.testMap` map
6. `refactor-plan` — skill `skills/refactor-planner`, target `.`, output `LoopOutputLayout.refactorPlan`, prompt v3
7. `refactor-plan-check` — `.artifactCheck` with `refactorPlanCheckSpec`
8. `refactor-test-write` — skill `skills/test-gap-writer`, target `llm-doc/loop/refactor/NEXT-BATCH.md` (the runner writes it from `RefactorPlanDiff.firstTodo` right before this stage; when there is no todo batch the stage is skipped as passed with "no todo batch"), output `.`; `testWriteOnly` (create-only guard applies)
9. `refactor-test-baseline` — shell, detected command, `allowsRepair: false`, blocking (also runs written roots via the existing hook)
10. `refactor-apply` — skill `skills/refactor-apply`, target = plan, output `.`, prompt v3
11. `refactor-test` — shell, detected command (repair allowed; apply runs under `.warn`)
12. `refactor-ledger` — `.testMap` ledger
13. `refactor-graph-check` — `.codeGraph` verify
Without a runner: 1-7 only (plan-only), setup enabled. `isManualOnly` stays true (key in `manualOnly`).
- Prompts (path-agnostic): `refactorPlanPrompt` v3: "Write or update the refactor plan at the Output path for the code under the Input, driven by the code-graph snapshot and the test map the loop wrote beside it (read them first). Rank batches by measured structure — cycles, files over 500 lines, high fan-in files mixing roles — then naming and docs. Every batch carries a stable ID, a status, its files, the symbols it moves, which of its files still lack tests, its intent, its risk, and an Expect line naming the graph counter it will reduce. Keep batches small, behaviour-preserving, ordered by value then safety. Never edit code." `refactorApplyPrompt` v3: "Apply exactly the FIRST todo batch of the plan at the Input to the code under the Output path, using the graph snapshot beside the plan to find every dependant of the files you move or split. Preserve every listed symbol, update every import, reference and build-config path, weaken no test, and mark the batch done (or skipped with the reason). Never touch more than that batch, never commit. End with `Applied: R<n>`." `testWritePrompt` reuse from the Test loop with the batch-mode sentence: "The Input is the next refactor batch: create new test files for EVERY file it lists as missing tests, pinning current behaviour."
- Contract: ("Move the codebase toward a professional, graph-verified structure one tested, behaviour-preserving batch at a time.", "Every file the batch touches has tests that passed before the change, the suite passes after it, and the fresh code-graph snapshot shows the batch's declared counter lower with no structural counter higher.")

- [ ] **Step 1: Failing tests**

```swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorRefactorLoopTests: XCTestCase {
    func testOrderWithRunner() throws {
        let root = try TempRepo.make(files: ["Package.swift": "// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: \"x\", targets: [.testTarget(name: \"XTests\")])\n"])
        let s = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: root)
        XCTAssertEqual(s.map(\.defaultKey), ["refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check", "refactor-test-write", "refactor-test-baseline", "refactor-apply", "refactor-test", "refactor-ledger", "refactor-graph-check"])
        XCTAssertEqual(s[1].enabled, false); XCTAssertEqual(s[3].graphOp, .snapshot); XCTAssertEqual(s[12].graphOp, .verify)
        XCTAssertEqual(s[8].allowsRepair, false); XCTAssertTrue(s[10].allowsRepair)
        XCTAssertTrue(s[7].testWriteOnly)
        XCTAssertFalse(s.filter(\.enabled).contains { LoopStage.lacksVerifyAfter($0, in: s) })
    }
    func testPlanOnlyWithoutRunner() throws {
        let root = try TempRepo.make(files: ["README.md": "x"])
        let s = LoopStageDetector.defaultStages(forLoop: LoopDefaultLoopKey.refactor, gitRoot: root)
        XCTAssertEqual(s.map(\.defaultKey), ["refactor-structure", "refactor-setup", "refactor-structure-check", "refactor-graph", "refactor-test-map", "refactor-plan", "refactor-plan-check"])
        XCTAssertEqual(s[1].enabled, true)
    }
    func testStillManualOnly() throws {
        let root = try TempRepo.make(files: ["Package.swift": "let p = Package(targets: [.testTarget(name: \"XTests\")])"])
        XCTAssertTrue(LoopStageDetector.defaultLoops(gitRoot: root).first { $0.defaultKey == LoopDefaultLoopKey.refactor }!.isManualOnly)
    }
}
```
(`TempRepo` exists from the Test loop work — grep `struct TempRepo`/`enum TempRepo` in mac/Tests.)

- [ ] **Step 2: Fail.** - [ ] **Step 3: Implement** incl. the NEXT-BATCH.md write in the runner right before a `refactor-test-write` stage (in `LoopEngineRunner+CodeGraph.swift`: `prepareNextBatchFile(stages:)` called from the skill-stage path when `stage.defaultKey == "refactor-test-write"` or, more robustly, when `stage.testWriteOnly && stage.targetPath` ends with `NEXT-BATCH.md`). - [ ] **Step 4: Full suite; boundaries; `make loop-gates`.**
- [ ] **Step 5: Commit** — `feat(mac): premium Refactoring loop — tests first, graph snapshot, plan, apply, test, ledger, graph check`

### Task 8: Docs, changelog, kit pin, live-check expectation

- [ ] `docs/explanation/loop-engineering.md`: Refactoring row in `## Loops`; `.codeGraph` kind under `## Stages`; a subsection "Structure is verified by the graph" after "Regressions become faults" (counters, cycles, the Expect contract, `allowsRepair`); `docs/spec/macos-app.md` Loop paragraph (stage list, `llm-doc/loop/refactor/graph/` layout, graph.json 1.1 `calls`, `GraphRescanning` contract, journal fields `batchId`/`graphDelta`). `CHANGELOG.md` entry + downgrade note (older builds read `.codeGraph` as unsupported; graph.json 1.1 is a superset of 1.0). `make docs-check`.
- [ ] After the user merges `.skills` `feat/refactor-loop-skills` to kit main: `git add .skills`.
- [ ] Live-check expectation (user runs in the app): Loop → Refactoring → Run on llm-ide. Expect `llm-doc/loop/refactor/GRAPH.md` with `boundaryWarnings: 46`, oversized files led by `LoopEngineRunner.swift`, cycles section (likely empty for Swift until call edges exist for it — note what it shows), `REFACTOR.md` R1 with an `Expect:` naming a GRAPH.md counter, `NEXT-BATCH.md`, new test files only, baseline green, one batch applied, suite green, `GRAPH-DELTA.md` with the counter lower.
- [ ] Commit — `docs: premium Refactoring loop, code graph 1.1, kit pin`

## Self-review

- Spec coverage: check tests / generate missing ones for what will be touched → Tasks 6 (batch mode), 7 (stages 5, 8, 9); copy the code graph → Task 4 snapshot + Task 1 rescan + Task 2 call edges; structure to professional level from the graph → Task 3 counters + Task 6 planner criteria + Task 5 plan check; refactor → stage 10; check the tests → stages 9 (baseline, no repair), 11, 12; graph-verified → stage 13. Heavy and systematic: 13 stages, each deterministic except the three skills.
- Placeholder scan: every code step has code or an exact edit; "match real memberwise labels" and "grep the existing helper" are locating instructions with contracts fixed by assertions.
- Type consistency: `GraphRescanning`/`GraphRescanOutcome`, `GraphIndex.calls`/`callerFiles(of:)`, `GraphReport.build(from:commit:boundaryWarnings:)`/`delta(before:after:expect:)`, `GraphDelta.render(batchId:)`, `CodeGraphOp`, `LoopStage.graphOp`/`allowsRepair`/`isRefactorApply`, `LoopStageAttempt.batchId`/`graphDelta`, `RefactorPlanDiff.firstTodo(in:)`/`appliedBatch(before:after:)`, `ArtifactCheckSpec.SectionRule`, `LoopOutputLayout.refactorGraph*` are used with the same names throughout.
