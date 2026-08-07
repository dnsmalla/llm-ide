# Loop Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the app's existing single-attempt Regression check into a multi-stage (Regression → Test → user-added), multi-iteration loop with auto-fix retry, exposed via a Code Assistant chat action and a new Auto Task type.

**Architecture:** New Mac-only files under `Models/LoopEngine/`, `Services/LoopEngine/`, `Views/LoopEngine/` implement the loop itself, reusing `RegressionRunner`, `ShellFaultVerifier`, and `VerifyApprovalStore` rather than duplicating them. Existing enums (`AutoTask`, `ShellState.Section`, `HelpTopic`) each gain one new case, following the exact pattern their `.regression` case already established. No server (`extension/`) changes.

**Tech Stack:** Swift, SwiftUI, XCTest, `@testable import LlmIdeMacLib`, `Combine`, `CryptoKit` (SHA256, already used by `VerifyApprovalStore`).

Spec: `docs/superpowers/specs/2026-08-07-loop-engineering-design.md` — read it once before starting; this plan implements it task-by-task.

---

### Task 1: `LoopStage` and `LoopEngineConfig` models

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift`
- Create: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopStageTests.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/LoopStageTests.swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageTests: XCTestCase {
    func testRegressionSweepStageRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
    }

    func testShellCommandStageRoundTripsThroughJSON() throws {
        let stage = LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 1)
        let data = try JSONEncoder().encode(stage)
        let decoded = try JSONDecoder().decode(LoopStage.self, from: data)
        XCTAssertEqual(decoded, stage)
        XCTAssertEqual(decoded.command, "swift test")
    }
}
```

```swift
// mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift
import XCTest
@testable import LlmIdeMacLib

final class LoopEngineConfigTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "loop-engine-config-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testLoadReturnsNilWhenNothingSaved() {
        XCTAssertNil(LoopEngineConfig.load(for: "proj-1", defaults: suite))
    }

    func testSaveThenLoadRoundTrips() {
        let config = LoopEngineConfig(
            stages: [LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)],
            maxIterations: 7,
            consecutiveFailureStop: 3
        )
        config.save(for: "proj-1", defaults: suite)
        let loaded = LoopEngineConfig.load(for: "proj-1", defaults: suite)
        XCTAssertEqual(loaded, config)
    }

    func testDifferentProjectsDoNotShareConfig() {
        let a = LoopEngineConfig(stages: [], maxIterations: 5, consecutiveFailureStop: 2)
        a.save(for: "proj-a", defaults: suite)
        XCTAssertNil(LoopEngineConfig.load(for: "proj-b", defaults: suite))
    }

    func testDefaultsAreFiveAndTwo() {
        let config = LoopEngineConfig(stages: [])
        XCTAssertEqual(config.maxIterations, 5)
        XCTAssertEqual(config.consecutiveFailureStop, 2)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail (types don't exist yet)**

Run: `cd mac && swift test --filter LoopStageTests`
Expected: FAIL with `cannot find type 'LoopStage' in scope`

- [ ] **Step 3: Write the models**

```swift
// mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift
import Foundation

/// One step of a Loop Engineering run. `.regressionSweep` re-runs the
/// existing `RegressionRunner` sweep (no shell command of its own);
/// `.shellCommand` runs an arbitrary project command (e.g. "swift test")
/// via `ShellFaultVerifier`, gated by `VerifyApprovalStore` like a fault
/// verify command.
struct LoopStage: Identifiable, Codable, Equatable {
    enum Kind: String, Codable {
        case regressionSweep
        case shellCommand
    }

    var id: String = UUID().uuidString
    var name: String
    var kind: Kind
    /// nil for `.regressionSweep`; required for `.shellCommand`.
    var command: String?
    var order: Int
}
```

```swift
// mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift
import Foundation

/// Per-project Loop Engineering contract: the ordered stage list plus
/// stop conditions. Persisted as UserDefaults JSON, one entry per
/// project id — same idiom as `CustomAutoTask`/`CustomProvider`, and
/// local-only (never synced), matching how Repo/Issues/Gantt config
/// already works.
struct LoopEngineConfig: Codable, Equatable {
    var stages: [LoopStage]
    var maxIterations: Int = 5
    var consecutiveFailureStop: Int = 2

    private static func key(for projectId: String) -> String {
        "loopEngineConfig_\(projectId)"
    }

    static func load(for projectId: String, defaults: UserDefaults = .standard) -> LoopEngineConfig? {
        guard let data = defaults.data(forKey: key(for: projectId)),
              let config = try? JSONDecoder().decode(LoopEngineConfig.self, from: data)
        else { return nil }
        return config
    }

    func save(for projectId: String, defaults: UserDefaults = .standard) {
        guard let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: Self.key(for: projectId))
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter LoopStageTests && swift test --filter LoopEngineConfigTests`
Expected: PASS (4 + 4 tests)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopStage.swift \
        mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift \
        mac/Tests/LlmIdeMacTests/LoopStageTests.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift
git commit -m "feat(mac): add LoopStage and LoopEngineConfig models"
```

---

### Task 2: `LoopStageDetector` (auto-detect default stages)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift
import XCTest
@testable import LlmIdeMacLib

final class LoopStageDetectorTests: XCTestCase {
    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("loop-stage-detector-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        tempDir = nil
        super.tearDown()
    }

    private func write(_ name: String, _ contents: String = "") {
        try? contents.write(to: tempDir.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    func testAlwaysIncludesRegressionStageFirst() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.first?.kind, .regressionSweep)
        XCTAssertEqual(stages.first?.order, 0)
    }

    func testNoRecognizedProjectFileYieldsRegressionOnly() {
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testPackageSwiftYieldsSwiftTest() {
        write("Package.swift")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "swift test")
    }

    func testPackageJSONWithTestScriptYieldsNpmTest() {
        write("package.json", #"{"scripts": {"test": "vitest"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "npm test")
    }

    func testPackageJSONWithoutTestScriptYieldsRegressionOnly() {
        write("package.json", #"{"scripts": {"build": "vite build"}}"#)
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.count, 1)
    }

    func testMakefileWithTestTargetYieldsMakeTest() {
        write("Makefile", "test:\n\techo hi\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "make test")
    }

    func testPyprojectTomlYieldsPytest() {
        write("pyproject.toml", "[tool.pytest.ini_options]\n")
        let stages = LoopStageDetector.detectDefaultStages(gitRoot: tempDir)
        XCTAssertEqual(stages.last?.command, "pytest")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter LoopStageDetectorTests`
Expected: FAIL with `cannot find 'LoopStageDetector' in scope`

- [ ] **Step 3: Write the detector**

```swift
// mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift
import Foundation

/// Sniffs a repo's root for common test-command conventions to propose a
/// default stage list, the first time a project has no saved
/// `LoopEngineConfig`. The user edits/overrides from there — this only
/// ever runs once per project (see `LoopEngineView`).
enum LoopStageDetector {
    static func detectDefaultStages(gitRoot: URL) -> [LoopStage] {
        var stages: [LoopStage] = [
            LoopStage(name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ]
        if let testCommand = detectTestCommand(gitRoot: gitRoot) {
            stages.append(LoopStage(name: "Test", kind: .shellCommand, command: testCommand, order: 1))
        }
        return stages
    }

    private static func detectTestCommand(gitRoot: URL) -> String? {
        let fm = FileManager.default

        if fm.fileExists(atPath: gitRoot.appendingPathComponent("Package.swift").path) {
            return "swift test"
        }

        if let packageJSON = try? String(
            contentsOf: gitRoot.appendingPathComponent("package.json"), encoding: .utf8
        ), packageJSON.contains("\"test\"") {
            return "npm test"
        }

        if let makefile = try? String(
            contentsOf: gitRoot.appendingPathComponent("Makefile"), encoding: .utf8
        ), makefile.range(of: #"(?m)^(test|regression):"#, options: .regularExpression) != nil {
            return "make test"
        }

        let pytestMarkers = ["pytest.ini", "pyproject.toml", "setup.cfg"]
        for marker in pytestMarkers {
            let path = gitRoot.appendingPathComponent(marker)
            if fm.fileExists(atPath: path.path) {
                if marker == "pytest.ini" { return "pytest" }
                if let contents = try? String(contentsOf: path, encoding: .utf8),
                   contents.contains("pytest") {
                    return "pytest"
                }
            }
        }

        return nil
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter LoopStageDetectorTests`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageDetector.swift \
        mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift
git commit -m "feat(mac): add LoopStageDetector for default stage auto-detection"
```

---

### Task 3: Stage-scoped approval helpers on `VerifyApprovalStore`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/VerifyApprovalStoreLoopStageTests.swift`

`VerifyApprovalStore.isApproved`/`approve` already take an arbitrary `faultFile: String` as part of the hash — no structural change is needed, just a small convenience wrapper so call sites don't hand-roll the `"loopstage:"` prefix convention.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/VerifyApprovalStoreLoopStageTests.swift
import XCTest
@testable import LlmIdeMacLib

final class VerifyApprovalStoreLoopStageTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "verify-approval-loop-stage-test-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testStageCommandStartsUnapproved() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        XCTAssertFalse(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test"))
    }

    func testApproveStageMakesItApproved() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        XCTAssertTrue(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test"))
    }

    func testEditingTheCommandRevokesApproval() {
        let store = VerifyApprovalStore(defaults: suite)
        let repo = URL(fileURLWithPath: "/tmp/some-repo")
        store.approveStage(repo: repo, stageId: "t1", command: "swift test")
        XCTAssertFalse(store.isStageApproved(repo: repo, stageId: "t1", command: "swift test --parallel"))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter VerifyApprovalStoreLoopStageTests`
Expected: FAIL with `value of type 'VerifyApprovalStore' has no member 'isStageApproved'`

- [ ] **Step 3: Add the convenience wrappers**

Append to `mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift`, inside the `VerifyApprovalStore` class body (after `approve`):

```swift
    /// Stage commands reuse the same repo+faultFile+command hash scheme as
    /// fault verify commands, distinguished by a "loopstage:<id>" faultFile
    /// so the two approval spaces never collide.
    func isStageApproved(repo: URL, stageId: String, command: String) -> Bool {
        isApproved(repo: repo, faultFile: "loopstage:\(stageId)", command: command)
    }

    func approveStage(repo: URL, stageId: String, command: String) {
        approve(repo: repo, faultFile: "loopstage:\(stageId)", command: command)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter VerifyApprovalStoreLoopStageTests`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/VerifyApprovalStore.swift \
        mac/Tests/LlmIdeMacTests/VerifyApprovalStoreLoopStageTests.swift
git commit -m "feat(mac): add stage-scoped approval helpers to VerifyApprovalStore"
```

---

### Task 4: `LoopStageRepairer` protocol + production adapter

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageRepairer.swift`
- Test: `mac/Tests/LlmIdeMacTests/AgentLoopStageRepairerTests.swift`

Mirrors `FaultRepairer`/`AgentFaultRepairer` (`mac/Sources/LlmIdeMac/Services/FaultRepairer.swift`), generalized to a named stage instead of a `FaultReport`. The prompt builder is factored into a `static func` (unlike `AgentFaultRepairer`, which inlines it) so it's unit-testable without a network call — same pattern `CodeAssistJudge.buildPrompt` already uses in `RegressionRunner.swift`.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/AgentLoopStageRepairerTests.swift
import XCTest
@testable import LlmIdeMacLib

final class AgentLoopStageRepairerTests: XCTestCase {
    func testPromptIncludesStageNameCommandAndFailureOutput() {
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Test",
            command: "swift test",
            failureOutput: "XCTAssertEqual failed: (\"1\") is not equal to (\"2\")",
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertTrue(prompt.contains("\"Test\""))
        XCTAssertTrue(prompt.contains("swift test"))
        XCTAssertTrue(prompt.contains("XCTAssertEqual failed"))
        XCTAssertTrue(prompt.contains("/tmp/repo"))
    }

    func testPromptOmitsCommandLineWhenNil() {
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Regression",
            command: nil,
            failureOutput: "some failure",
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertFalse(prompt.contains("Command:"))
    }

    func testLongFailureOutputIsTruncated() {
        let huge = String(repeating: "x", count: 10_000)
        let prompt = AgentLoopStageRepairer.buildPrompt(
            stageName: "Test", command: "swift test", failureOutput: huge,
            repoRoot: URL(fileURLWithPath: "/tmp/repo")
        )
        XCTAssertLessThan(prompt.count, huge.count)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter AgentLoopStageRepairerTests`
Expected: FAIL with `cannot find 'AgentLoopStageRepairer' in scope`

- [ ] **Step 3: Write the protocol and adapter**

```swift
// mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageRepairer.swift
import Foundation

/// Attempts to fix a failing Loop Engineering stage. Generalizes
/// `FaultRepairer` (which is tied to a single `FaultReport`) to an
/// arbitrary named stage + command + failure output.
protocol LoopStageRepairer: AnyObject {
    func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws
}

/// Production adapter — same `api.codeAssist` transport `AgentFaultRepairer`
/// uses; the agent has write tools in this deployment and edits the working
/// tree directly.
final class AgentLoopStageRepairer: LoopStageRepairer {
    private let api: LlmIdeAPIClient
    private let language: String

    init(api: LlmIdeAPIClient, language: String = "en") {
        self.api = api
        self.language = language
    }

    private static let maxFailureOutputChars = 4_000

    static func buildPrompt(stageName: String, command: String?, failureOutput: String, repoRoot: URL) -> String {
        let commandLine = command.map { "Command: \($0)\n" } ?? ""
        return """
        The "\(stageName)" stage of a Loop Engineering run is failing in the codebase at \(repoRoot.path).

        \(commandLine)Failure output:
        \(String(failureOutput.prefix(maxFailureOutputChars)))

        Edit the code so this stage passes. Make the minimal change required.
        """
    }

    func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
        let prompt = Self.buildPrompt(stageName: stageName, command: command,
                                       failureOutput: failureOutput, repoRoot: repoRoot)
        _ = try await api.codeAssist(
            message: prompt, language: language, model: nil,
            history: [], attachments: [], agentContext: nil
        )
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter AgentLoopStageRepairerTests`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopStageRepairer.swift \
        mac/Tests/LlmIdeMacTests/AgentLoopStageRepairerTests.swift
git commit -m "feat(mac): add LoopStageRepairer protocol and AgentLoopStageRepairer"
```

---

### Task 5: `RegressionSweepRunning` adapter (testability seam for the Regression stage)

**Files:**
- Create: `mac/Sources/LlmIdeMac/Services/LoopEngine/RegressionSweepRunning.swift`
- Test: `mac/Tests/LlmIdeMacTests/RegressionRunnerSweepAdapterTests.swift`

`LoopEngineRunner` (Task 6) must not depend on `RegressionRunner`'s concrete `api`/`prompter`/`judge` wiring in its own tests. This protocol is the same style of seam `RegressionRunner` itself uses for `RegressionPrompter`/`FaultVerifier`/`FaultRepairer`.

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/RegressionRunnerSweepAdapterTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class RegressionRunnerSweepAdapterTests: XCTestCase {
    private final class StubPrompter: RegressionPrompter {
        func ask(prompt: String) async throws -> String { prompt }
    }

    func testSweepPassedTrueWhenNoFixedFaultsExist() async {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("regression-sweep-adapter-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let runner = RegressionRunner(prompter: StubPrompter())
        let adapter = RegressionRunnerSweepAdapter(runner: runner)
        let passed = await adapter.sweepPassed(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: true)
        XCTAssertTrue(passed)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter RegressionRunnerSweepAdapterTests`
Expected: FAIL with `cannot find 'RegressionRunnerSweepAdapter' in scope`

- [ ] **Step 3: Write the protocol and adapter**

```swift
// mac/Sources/LlmIdeMac/Services/LoopEngine/RegressionSweepRunning.swift
import Foundation

/// Runs a Regression stage and reports pass/fail as a single boolean —
/// the seam `LoopEngineRunner` depends on instead of `RegressionRunner`
/// directly, so its own tests can fake this stage in isolation.
protocol RegressionSweepRunning {
    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool
}

/// Production adapter wrapping the real `RegressionRunner`. A sweep
/// "passes" when no fault came back `.regressed`, `.repairFailed`, or
/// `.needsApproval` — `.unchanged` and `.repaired` both count as passing.
@MainActor
final class RegressionRunnerSweepAdapter: RegressionSweepRunning {
    private let runner: RegressionRunner

    init(runner: RegressionRunner) {
        self.runner = runner
    }

    func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool {
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair)
        return !runner.results.contains { result in
            switch result.verdict {
            case .regressed, .repairFailed, .needsApproval: return true
            default: return false
            }
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift test --filter RegressionRunnerSweepAdapterTests`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/LoopEngine/RegressionSweepRunning.swift \
        mac/Tests/LlmIdeMacTests/RegressionRunnerSweepAdapterTests.swift
git commit -m "feat(mac): add RegressionSweepRunning seam for the Loop Engine's Regression stage"
```

---

### Task 6: `LoopEngineRunner` — the core iteration loop

**Files:**
- Create: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineStatus.swift`
- Create: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`
- Test: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`

This is the heart of the feature: run every stage in order each iteration; on a `.shellCommand` failure, repair and retry; on a `.regressionSweep` failure, just retry (it already made its own one-shot repair attempt internally); stop on success, `maxIterations`, `consecutiveFailureStop`, or an unapproved stage.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class LoopEngineRunnerTests: XCTestCase {
    private final class StubVerifier: FaultVerifier {
        /// One scripted outcome per call, in order; the last is repeated
        /// once exhausted.
        var outcomes: [VerifyOutcome]
        private(set) var callCount = 0
        init(outcomes: [VerifyOutcome]) { self.outcomes = outcomes }
        func verify(command: String, repoRoot: URL, timeout: TimeInterval) async throws -> VerifyOutcome {
            defer { callCount += 1 }
            return outcomes[min(callCount, outcomes.count - 1)]
        }
    }

    private final class StubRepairer: LoopStageRepairer {
        private(set) var repairCount = 0
        func repair(stageName: String, command: String?, failureOutput: String, repoRoot: URL) async throws {
            repairCount += 1
        }
    }

    private final class StubRegressionSweep: RegressionSweepRunning {
        var alwaysPasses: Bool
        init(alwaysPasses: Bool) { self.alwaysPasses = alwaysPasses }
        func sweepPassed(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> Bool { alwaysPasses }
    }

    private func makeApprovals(approve stages: [(stageId: String, command: String)] = []) -> VerifyApprovalStore {
        let suite = UserDefaults(suiteName: "loop-engine-runner-test-\(UUID().uuidString)")!
        let store = VerifyApprovalStore(defaults: suite)
        for (stageId, command) in stages {
            store.approveStage(repo: URL(fileURLWithPath: "/tmp/repo"), stageId: stageId, command: command)
        }
        return store
    }

    private let repoRoot = URL(fileURLWithPath: "/tmp/repo")

    func testAllStagesPassOnFirstIterationSucceeds() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 0, output: "")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .success)
        XCTAssertEqual(runner.iteration, 1)
        XCTAssertEqual(repairer.repairCount, 0)
    }

    func testOneFailureThenFixThenPassSucceedsOnSecondIteration() async {
        let verifier = StubVerifier(outcomes: [
            VerifyOutcome(exitCode: 1, output: "boom"),
            VerifyOutcome(exitCode: 0, output: "")
        ])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .success)
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 1)
    }

    func testMaxIterationsGivesUpWhenNeverFixed() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 1, output: "still broken 1")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 3, consecutiveFailureStop: 10)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 3)
    }

    func testConsecutiveIdenticalFailuresGivesUpBeforeMaxIterations() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 1, output: "identical failure")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals(approve: [("t1", "swift test")])
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .givenUp(reason: .repeatedFailure))
        XCTAssertEqual(runner.iteration, 2)
    }

    func testUnapprovedShellStageStopsImmediatelyWithoutRepairing() async {
        let verifier = StubVerifier(outcomes: [VerifyOutcome(exitCode: 0, output: "")])
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "t1", name: "Test", kind: .shellCommand, command: "swift test", order: 0)
        ], maxIterations: 5, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier, stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: true),
            approvals: makeApprovals()   // nothing approved
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .needsApproval(stageName: "Test"))
        XCTAssertEqual(repairer.repairCount, 0)
    }

    func testFailingRegressionStageRetriesWithoutCallingStageRepairer() async {
        let repairer = StubRepairer()
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 2, consecutiveFailureStop: 5)
        let runner = LoopEngineRunner(
            verifier: StubVerifier(outcomes: [VerifyOutcome(exitCode: 0, output: "")]),
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            approvals: makeApprovals()
        )
        await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(runner.status, .givenUp(reason: .maxIterations))
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 0)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter LoopEngineRunnerTests`
Expected: FAIL with `cannot find 'LoopEngineRunner' in scope`

- [ ] **Step 3: Write `LoopEngineStatus`**

```swift
// mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineStatus.swift
import Foundation

enum LoopEngineStatus: Equatable {
    enum GivenUpReason: Equatable {
        case maxIterations
        case repeatedFailure
    }

    case success
    case givenUp(reason: GivenUpReason)
    case needsApproval(stageName: String)
    case error(String)
    case aborted
}
```

- [ ] **Step 4: Write `LoopEngineRunner`**

```swift
// mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift
import Foundation
import CryptoKit

/// Drives a Loop Engineering run: repeats the full ordered stage list,
/// on a `.shellCommand` failure calls `stageRepairer` and retries, on a
/// `.regressionSweep` failure just retries (the sweep already made its
/// own one-shot repair attempt internally). Every iteration re-runs
/// every stage from the top so a fix to a later stage can't silently
/// leave an earlier one broken.
@MainActor
final class LoopEngineRunner: ObservableObject {
    struct LogLine: Identifiable, Equatable {
        enum Level: Equatable { case info, warn, error }
        let id = UUID()
        let at: Date
        let level: Level
        let text: String
    }

    @Published private(set) var running = false
    @Published private(set) var log: [LogLine] = []
    @Published private(set) var status: LoopEngineStatus?
    @Published private(set) var iteration = 0

    private let verifier: FaultVerifier
    private let stageRepairer: LoopStageRepairer
    private let regressionSweep: RegressionSweepRunning
    private let approvals: VerifyApprovalStore
    private let stageTimeout: TimeInterval

    init(verifier: FaultVerifier = ShellFaultVerifier(),
         stageRepairer: LoopStageRepairer,
         regressionSweep: RegressionSweepRunning,
         approvals: VerifyApprovalStore = VerifyApprovalStore(),
         stageTimeout: TimeInterval = 600) {
        self.verifier = verifier
        self.stageRepairer = stageRepairer
        self.regressionSweep = regressionSweep
        self.approvals = approvals
        self.stageTimeout = stageTimeout
    }

    func clearLog() { log.removeAll() }

    func run(config: LoopEngineConfig, faultsRoot: URL, gitRoot: URL) async {
        guard !running else { return }
        running = true
        status = nil
        iteration = 0
        defer { running = false }

        let orderedStages = config.stages.sorted { $0.order < $1.order }
        var lastFailureHash: String?
        var consecutiveSameFailures = 0

        appendLog(.info, "Loop started · \(orderedStages.count) stage(s), max \(config.maxIterations) iteration(s)")

        iterationLoop: while iteration < config.maxIterations {
            iteration += 1
            appendLog(.info, "Iteration \(iteration)/\(config.maxIterations)")

            for stage in orderedStages {
                switch stage.kind {
                case .regressionSweep:
                    let passed = await regressionSweep.sweepPassed(
                        faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true)
                    appendLog(passed ? .info : .warn, "  [\(stage.name)] \(passed ? "passed" : "failed")")
                    if !passed {
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        continue iterationLoop
                    }

                case .shellCommand:
                    guard let command = stage.command else {
                        status = .error("Stage \"\(stage.name)\" has no command")
                        break iterationLoop
                    }
                    guard approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) else {
                        appendLog(.warn, "  [\(stage.name)] needs approval: \(command)")
                        status = .needsApproval(stageName: stage.name)
                        break iterationLoop
                    }
                    do {
                        let outcome = try await verifier.verify(command: command, repoRoot: gitRoot, timeout: stageTimeout)
                        if outcome.exitCode == 0 {
                            appendLog(.info, "  [\(stage.name)] passed")
                            continue
                        }
                        appendLog(.warn, "  [\(stage.name)] FAILED (exit \(outcome.exitCode))")
                        let hash = Self.hash(outcome.output)
                        consecutiveSameFailures = (hash == lastFailureHash) ? consecutiveSameFailures + 1 : 1
                        lastFailureHash = hash
                        if consecutiveSameFailures >= config.consecutiveFailureStop {
                            status = .givenUp(reason: .repeatedFailure)
                            break iterationLoop
                        }
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        appendLog(.info, "  [\(stage.name)] repairing…")
                        try await stageRepairer.repair(
                            stageName: stage.name, command: command,
                            failureOutput: outcome.output, repoRoot: gitRoot)
                        continue iterationLoop
                    } catch {
                        status = .error("\(error)")
                        break iterationLoop
                    }
                }
            }

            if status == nil {
                status = .success
                break iterationLoop
            }
        }

        if status == nil { status = .givenUp(reason: .maxIterations) }
        appendLog(.info, "Loop finished · \(describe(status!))")
    }

    private func appendLog(_ level: LogLine.Level, _ text: String) {
        log.append(LogLine(at: Date(), level: level, text: text))
    }

    private static func hash(_ s: String) -> String {
        let digest = SHA256.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func describe(_ status: LoopEngineStatus) -> String {
        switch status {
        case .success: return "success"
        case .givenUp(.maxIterations): return "given up (max iterations)"
        case .givenUp(.repeatedFailure): return "given up (repeated failure)"
        case .needsApproval(let name): return "needs approval: \(name)"
        case .error(let msg): return "error: \(msg)"
        case .aborted: return "aborted"
        }
    }
}
```

Note the `case .shellCommand: ... continue` inside the `for` loop (not `continue iterationLoop`) after a stage passes — that's a plain loop continue to the next stage, deliberately distinct from the labeled `continue iterationLoop` used to retry the whole iteration.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd mac && swift test --filter LoopEngineRunnerTests`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineStatus.swift \
        mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "feat(mac): add LoopEngineRunner iteration loop"
```

---

### Task 7: `AutoTask.loopEngineering` case

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/AutoCode/AutoTask.swift`
- Test: `mac/Tests/LlmIdeMacTests/AutoTaskLoopEngineeringTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
// mac/Tests/LlmIdeMacTests/AutoTaskLoopEngineeringTests.swift
import XCTest
@testable import LlmIdeMacLib

final class AutoTaskLoopEngineeringTests: XCTestCase {
    func testLoopEngineeringIsInAllCases() {
        XCTAssertTrue(AutoTask.allCases.contains(.loopEngineering))
    }

    func testLoopEngineeringLabelAndIcon() {
        XCTAssertEqual(AutoTask.loopEngineering.label, "Loop Engineering")
        XCTAssertFalse(AutoTask.loopEngineering.icon.isEmpty)
    }

    func testLoopEngineeringLogSuffix() {
        XCTAssertEqual(AutoTask.loopEngineering.logSuffix, "loop-engineering")
    }

    func testLoopEngineeringIsStructuralWithNoTemplate() {
        XCTAssertTrue(AutoTask.loopEngineering.isStructural)
    }

    func testLoopEngineeringRequiresLinkedRepo() {
        XCTAssertTrue(AutoTask.loopEngineering.requiresLinkedRepo)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd mac && swift test --filter AutoTaskLoopEngineeringTests`
Expected: FAIL — build error, `type 'AutoTask' has no member 'loopEngineering'`

- [ ] **Step 3: Add the case and its four switch entries**

In `mac/Sources/LlmIdeMac/Models/AutoCode/AutoTask.swift`:

```swift
    /// Multi-stage, multi-iteration loop (Regression -> Test -> ...) with
    /// auto-fix retry. Additive to `.regression`, which keeps its existing
    /// single-attempt behavior unchanged. Structural — configured via
    /// LoopEngineView, not a text template.
    case loopEngineering
```
— add immediately after `case updatePlanStatus` (before the closing of the case list, i.e. as the new last case).

```swift
        case .updatePlanStatus:  return "Update Plan Status"
        case .loopEngineering:   return "Loop Engineering"
```
— in `var label`.

```swift
        case .updatePlanStatus:  return "chart.bar.doc.horizontal"
        case .loopEngineering:   return "repeat.circle"
```
— in `var icon`.

```swift
        case .updatePlanStatus:  return "update-plan-status"
        case .loopEngineering:   return "loop-engineering"
```
— in `var logSuffix`.

In `templateBinding(config:)`, add `.loopEngineering` to the no-template case list:

```swift
        case .sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge,
             .regression, .generateKnowledge, .loopEngineering: return nil
```

In `resetTemplate(config:)`, add it to the matching no-op case list:

```swift
        case .sourceUpdate, .sourcesToIssue, .implementIssues, .reviewMerge,
             .regression, .generateKnowledge, .loopEngineering: break
```

(`isStructural` and `requiresLinkedRepo` both end in `default:` — no change needed there; the new case falls through to `true` in both, which is correct.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd mac && swift build --product LlmIdeMac && swift test --filter AutoTaskLoopEngineeringTests`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full Swift test suite to confirm the new case didn't break an exhaustive switch elsewhere**

Run: `cd mac && swift build --product LlmIdeMac`
Expected: builds clean. If it fails with "switch must be exhaustive" in another file, that file is Task 9's `AutoTaskSettings.swift` or Task 10's `AutoCodeUpdateService+PipelineTasks.swift`/`ShellState.swift`/`HelpGuideView.swift` — those are handled in later tasks; note the file/line and proceed, or reorder to do this task last if the build must stay green after every task.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/AutoCode/AutoTask.swift \
        mac/Tests/LlmIdeMacTests/AutoTaskLoopEngineeringTests.swift
git commit -m "feat(mac): add AutoTask.loopEngineering case"
```

> **Build-green note:** `AutoTask` is a non-`default` exhaustive switch in five places outside this file too (`AutoTaskSettings.isEnabled`/`setEnabled`, `AutoCodeUpdateService+PipelineTasks.isTaskEnabled`/`runTaskBody`, and none in `HelpGuideView`/`ShellState` — those switch over `HelpTopic`/`ShellState.Section`, separate enums). Tasks 8–9 close those gaps. If you're executing this plan strictly task-by-task with a build check after each one, do Task 7 and Task 8 as a single combined commit instead of separately — see Task 8.

---

### Task 8: `AutoTaskSettings.runLoopEngineering`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/AutoCode/AutoTaskSettings.swift`
- Test: `mac/Tests/LlmIdeMacTests/AutoTaskSettingsLoopEngineeringTests.swift`

Follows `runRegression`'s exact five touch points: `@Published` declaration, `isEnabled`/`setEnabled`, `enabledTasks`, `init` default, `userDefaultsDidChange` sync.

- [ ] **Step 1: Write the failing tests**

```swift
// mac/Tests/LlmIdeMacTests/AutoTaskSettingsLoopEngineeringTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoTaskSettingsLoopEngineeringTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "auto-task-settings-loop-engineering-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    func testDefaultsToFalse() {
        let settings = AutoTaskSettings(defaults: suite)
        XCTAssertFalse(settings.runLoopEngineering)
        XCTAssertFalse(settings.isEnabled(task: .loopEngineering))
    }

    func testSetEnabledPersistsAcrossInstances() {
        let a = AutoTaskSettings(defaults: suite)
        a.setEnabled(true, task: .loopEngineering)
        let b = AutoTaskSettings(defaults: suite)
        XCTAssertTrue(b.runLoopEngineering)
        XCTAssertTrue(b.isEnabled(task: .loopEngineering))
    }

    func testEnabledTasksIncludesLoopEngineeringWhenOn() {
        let settings = AutoTaskSettings(defaults: suite)
        settings.runLoopEngineering = true
        XCTAssertTrue(settings.enabledTasks.contains("Loop Engineering"))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mac && swift test --filter AutoTaskSettingsLoopEngineeringTests`
Expected: FAIL to build — `value of type 'AutoTaskSettings' has no member 'runLoopEngineering'`

- [ ] **Step 3: Add the five touch points to `AutoTaskSettings.swift`**

After the `runReviewMerge` published property (before `regressionAttemptRepair`):

```swift
    @Published var runLoopEngineering: Bool {
        didSet(oldValue) {
            guard oldValue != runLoopEngineering else { return }
            save("autoCodeRunLoopEngineering", runLoopEngineering)
        }
    }
```

In `enabledTasks`, after `if runRegression { tasks.append("Regression") }`:

```swift
        if runLoopEngineering { tasks.append("Loop Engineering") }
```

In `isEnabled(task:)`, after `case .regression: return runRegression`:

```swift
        case .loopEngineering:   return runLoopEngineering
```

In `setEnabled(_:task:)`, after `case .regression: runRegression = value`:

```swift
        case .loopEngineering:   runLoopEngineering = value
```

In `init`, after `self.runRegression = defaults.object(forKey: "autoCodeRunRegression") as? Bool ?? false`:

```swift
        self.runLoopEngineering = defaults.object(forKey: "autoCodeRunLoopEngineering") as? Bool ?? false
```

In `userDefaultsDidChange`, after the `newRunRegression` block:

```swift
        let newRunLoopEngineering = defaults.object(forKey: "autoCodeRunLoopEngineering") as? Bool ?? false
        if newRunLoopEngineering != runLoopEngineering { runLoopEngineering = newRunLoopEngineering }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mac && swift test --filter AutoTaskSettingsLoopEngineeringTests`
Expected: PASS (3 tests)

- [ ] **Step 5: Full build to confirm all `AutoTask` exhaustive switches now compile**

Run: `cd mac && swift build --product LlmIdeMac`
Expected: builds clean (or reveals the remaining gap addressed in Task 9)

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Models/AutoCode/AutoTaskSettings.swift \
        mac/Tests/LlmIdeMacTests/AutoTaskSettingsLoopEngineeringTests.swift
git commit -m "feat(mac): add AutoTaskSettings.runLoopEngineering"
```

---

### Task 9: `AutoCodeUpdateService` — new Auto Task branch + `runLoopEngineeringSweep`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/ActivityStore.swift`
- Test: `mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceLoopEngineeringTests.swift`

Mirrors `runRegressionSweep` (`AutoCodeUpdateService+PipelineTasks.swift:444`) exactly, but builds a `LoopEngineConfig` (auto-detecting on first run) and drives `LoopEngineRunner` instead of `RegressionRunner` directly.

- [ ] **Step 1: Add `loopEngineeringDone` to `ActivityKind`**

In `mac/Sources/LlmIdeMac/Services/ActivityStore.swift`, next to `case regressionDone = "regression_done"`:

```swift
    case loopEngineeringDone = "loop_engineering_done"
```

- [ ] **Step 2: Add `isTaskEnabled` branch**

In `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift`, in `isTaskEnabled(_:)`, after `case .regression: return autoTaskSettings.runRegression`:

```swift
        case .loopEngineering:   return autoTaskSettings.runLoopEngineering
```

- [ ] **Step 3: Write the failing test for `runLoopEngineeringSweep`**

```swift
// mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceLoopEngineeringTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class AutoCodeUpdateServiceLoopEngineeringTests: XCTestCase {
    private var suiteName: String!
    private var suite: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "loop-eng-service-\(UUID().uuidString)"
        suite = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        suite = nil
        super.tearDown()
    }

    // Real init signature (verified against AutoCodeUpdateServiceCronTests.swift):
    // init(config: AppConfig, autoTaskSettings: AutoTaskSettings, backend: RepoBackend? = nil,
    //      registry: ProcessedActionsRegistry, projectStore: ProjectStore? = nil,
    //      api: LlmIdeAPIClient? = nil, logStore: TaskLogStore)
    // `registry` and `logStore` are REQUIRED (no default); `api`/`projectStore`/`backend` default to nil.
    private func makeService() -> AutoCodeUpdateService {
        let registry = ProcessedActionsRegistry(
            storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json"))
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: registry,
            logStore: TaskLogStore())
    }

    func testSkipsWithTaskErrorWhenProjectRootIsEmpty() async {
        let service = makeService()
        await service.runLoopEngineeringSweep(projectRoot: "", gitRoot: "")
        XCTAssertEqual(service.taskErrors[AutoTask.loopEngineering.rawValue], "Loop Engineering skipped — no project root resolved.")
    }
}
```

The `makeService()` helper above is written to the real, verified init signature (matching `AutoCodeUpdateServiceCronTests.swift`'s own `makeService()`) — no need to re-derive it, but do confirm `AppConfig(userDefaults:)`, `AutoTaskSettings(defaults:)`, `ProcessedActionsRegistry(storeURL:)`, and `TaskLogStore()` (no-arg) still match by reading those types quickly if anything seems off.

- [ ] **Step 4: Run test to verify it fails**

Run: `cd mac && swift test --filter AutoCodeUpdateServiceLoopEngineeringTests`
Expected: FAIL — `value of type 'AutoCodeUpdateService' has no member 'runLoopEngineeringSweep'`

- [ ] **Step 5: Add `runLoopEngineeringSweep` to `AutoCodeUpdateService+PipelineTasks.swift`**

Directly after `runRegressionSweep`:

```swift
    /// Loop Engineering sweep: chains Regression -> Test -> any further
    /// configured stages into one multi-iteration loop with auto-fix retry.
    /// Additive to `runRegressionSweep` — does not change its behavior.
    func runLoopEngineeringSweep(projectRoot: String, gitRoot: String) async {
        guard let api else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering skipped — no API client wired."
            return
        }
        guard !projectRoot.isEmpty else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering skipped — no project root resolved."
            return
        }
        guard !gitRoot.isEmpty else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering skipped — no git working tree resolved."
            return
        }
        // LoopEngineConfig is keyed by the stable llm-ide Project.id (see the
        // contract documented on LoopEngineConfig.load/save in Task 1) — NOT
        // `projectRoot` (a filesystem path) and NOT `resolved.projectId`
        // (that field is actually the REMOTE repo id — a GitLab numeric id,
        // "owner/name" for GitHub, or `linked.remoteId`; see
        // `attemptResolveBackendAndProject()` in
        // AutoCodeUpdateService+BackendResolution.swift). Using the wrong
        // key here would silently split one project's config in two.
        guard let projectId = projectStore?.activeProject?.bundle.id else {
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering skipped — no active project."
            return
        }
        let faultsRoot = URL(fileURLWithPath: projectRoot, isDirectory: true)
        let gitRootURL = URL(fileURLWithPath: gitRoot, isDirectory: true)

        let projectConfig = LoopEngineConfig.load(for: projectId)
            ?? {
                let detected = LoopEngineConfig(stages: LoopStageDetector.detectDefaultStages(gitRoot: gitRootURL))
                detected.save(for: projectId)
                return detected
            }()

        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI)
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: judge,
                                                verifier: ShellFaultVerifier(), repairer: repairer,
                                                verifyTimeout: autoTaskSettings.regressionVerifyTimeout, config: config)
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner)
        )
        // Task 6 hardening: run() returns LoopEngineStatus? (nil means this
        // call was rejected — another run is already in progress for this
        // repo, instance- or process-wide). Read the RETURN VALUE, not
        // runner.status, which is only meaningful when run() returns non-nil
        // (a rejected call leaves a fresh LoopEngineRunner's status at nil
        // anyway here, since we construct one per sweep, but the return
        // value is the documented contract to depend on).
        let result = await runner.run(config: projectConfig, faultsRoot: faultsRoot, gitRoot: gitRootURL)

        switch result {
        case .success:
            taskErrors.removeValue(forKey: AutoTask.loopEngineering.rawValue)
            logStore.append(.loopEngineering, "Loop finished — all \(projectConfig.stages.count) stage(s) passed after \(runner.iteration) iteration(s).")
        case .givenUp(let reason):
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering gave up (\(reason))."
            logStore.append(.loopEngineering, "Gave up after \(runner.iteration) iteration(s): \(reason)", level: .error)
        case .needsApproval(let stageName):
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering needs approval for stage \"\(stageName)\"."
            logStore.append(.loopEngineering, "Stopped — stage \"\(stageName)\" needs approval in Loop Engineering settings.", level: .error)
        case .error(let message):
            taskErrors[AutoTask.loopEngineering.rawValue] = "Loop Engineering error: \(message)"
            logStore.append(.loopEngineering, "Error: \(message)", level: .error)
        case .aborted:
            break
        case nil:
            // Rejected — a run is already in progress for this repo elsewhere
            // (e.g. the user started one from the chat panel or the Loop
            // Engineering page). Leave any existing taskErrors entry as-is.
            logStore.append(.loopEngineering, "Skipped — a Loop Engineering run is already in progress for this repo.")
            return
        }
        activity?.report(
            kind: .loopEngineeringDone,
            title: "Loop Engineering complete — \(result.map(describe) ?? "unknown")",
            detail: ["iterations": runner.iteration]
        )
    }

    private func describe(_ status: LoopEngineStatus) -> String {
        switch status {
        case .success: return "success"
        case .givenUp: return "gave up"
        case .needsApproval: return "needs approval"
        case .error: return "error"
        case .aborted: return "aborted"
        }
    }
```

- [ ] **Step 6: Wire the new Auto Task case into `run()`'s dispatch**

In `mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift`, in the same `switch task` block as `case .regression: currentStep = "Running Regression sweep"; await runRegressionSweep(...)`, add:

```swift
            case .loopEngineering:
                currentStep = "Running Loop Engineering"
                await runLoopEngineeringSweep(projectRoot: resolved.projectRoot, gitRoot: resolved.gitRoot)
```

- [ ] **Step 7: Run tests and full build**

Run: `cd mac && swift build --product LlmIdeMac && swift test --filter AutoCodeUpdateServiceLoopEngineeringTests`
Expected: builds clean, test PASSes. Adjust the test's `AutoCodeUpdateService` construction from Step 3 to match whatever the existing Cron/CustomTask test files actually use if it differs from the guess above.

- [ ] **Step 8: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService.swift \
        mac/Sources/LlmIdeMac/Services/AutoCode/AutoCodeUpdateService+PipelineTasks.swift \
        mac/Sources/LlmIdeMac/Services/ActivityStore.swift \
        mac/Tests/LlmIdeMacTests/AutoCodeUpdateServiceLoopEngineeringTests.swift
git commit -m "feat(mac): wire Loop Engineering into AutoCodeUpdateService as a new Auto Task"
```

At this point the feature is fully functional as an unattended Auto Task (toggle it on in Auto Tasks settings, it runs on its cron schedule) and shows up on a paired iPhone automatically via `MobileControlManager.buildAutoTaskState()`, which derives its list from `AutoTask.allCases` — the task list itself needs no mobile-side code change. (The iPhone's per-task SF Symbol is a separately-maintained String-keyed mirror in `ios_app/MyApp/Views/Control/AutoTaskView.swift`'s `taskIcon(_:)`; Task 7 already added the `"loopEngineering"` case there so the icon matches too, not just the task list.)

**Note:** `AutoCodeUpdateService.runTaskBody`'s dispatch `switch` has a `default: break` catch-all rather than being exhaustive, so before this task lands, toggling `.loopEngineering` on would have silently no-op'd (no build error, no runtime error, just nothing happening) — worth being aware of as a general pattern in that switch, not something this task needs to fix.

---

### Task 10: Navigation — `ShellState.Section.loopEngine` and `HelpTopic.loopEngine`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/HelpGuideView.swift`

No automated test here (both are pure UI plumbing/copy) — verify by building and by Task 11/12's manual check.

- [ ] **Step 1: Add the new case to `ShellState.Section`**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`:

```swift
    enum Section: String, Hashable, CaseIterable {
        case library, live, explorer, search, conflicts, sourceControl, issues, gantt, visual, docGen, autoCode, codeGraph, regression, loopEngine, settings
```

In `label`, after `case .regression: return "Regression"`:

```swift
            case .loopEngine: return "Loop Engineering"
```

In `icon`, after `case .regression: return "arrow.uturn.backward.circle"`:

```swift
            case .loopEngine: return "repeat.circle"
```

In the color switch, after `case .regression: return Color(red: 0.40, green: 0.75, blue: 0.50) // mint-green`:

```swift
        case .loopEngine: return Color(red: 0.35, green: 0.70, blue: 0.55) // mint-teal, adjacent to Regression's mint-green
```

- [ ] **Step 2: Route it in `AppShell.swift`**

In `mac/Sources/LlmIdeMac/Views/AppShell.swift`, after `case .regression: RegressionView(api: api)`:

```swift
        case .loopEngine: LoopEngineView(api: api)
```

(`LoopEngineView` is created in Task 11 — this line will not compile until then; do Task 10 and Task 11 as one combined commit if you need the build green after every step.)

- [ ] **Step 3: Add `HelpTopic.loopEngine`**

In `mac/Sources/LlmIdeMac/Views/HelpGuideView.swift`, add a case to whichever enum declares `HelpTopic` (find it via `grep -n "enum HelpTopic" mac/Sources/LlmIdeMac/Views/HelpGuideView.swift`) alongside `.regression`, then add matching entries to `topicContent`, `label`, `icon`, and `tint`:

```swift
        case .loopEngine:      loopEngineContent
```
```swift
        case .loopEngine:      return "Loop Engineering"
```
```swift
        case .loopEngine:      return "repeat.circle"
```
```swift
        case .loopEngine:      return Color(red: 0.35, green: 0.70, blue: 0.55)
```

Add a minimal content view near `regressionContent` (find it via `grep -n "regressionContent" mac/Sources/LlmIdeMac/Views/HelpGuideView.swift`), matching its structure:

```swift
    private var loopEngineContent: some View {
        HelpTopicBody(title: "Loop Engineering") {
            Text("Chains Regression, then Test, then any stages you add, into one loop: on a failure it asks the agent for a fix and retries, up to a configurable number of iterations. Configure stages and approve any shell commands from the Loop Engineering page before running.")
        }
    }
```

Check the exact container type `regressionContent` uses (`HelpTopicBody` is a guess based on the naming convention — confirm the real wrapper via `grep -n "private var regressionContent" -A 5 mac/Sources/LlmIdeMac/Views/HelpGuideView.swift` and match it exactly) before finalizing this step.

- [ ] **Step 4: Build**

Run: `cd mac && swift build --product LlmIdeMac`
Expected: fails until Task 11 adds `LoopEngineView` — acceptable if committing Task 10+11 together; otherwise stub `LoopEngineView` with `Text("TODO")` temporarily is NOT an option per this plan's no-placeholder rule, so do Tasks 10 and 11 as one unit.

- [ ] **Step 5: Commit together with Task 11** (see Task 11's Step 6)

---

### Task 11: `LoopEngineView`

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift`

Three-pane layout parallel to `RegressionView`: stages editor / contract + selected-stage detail / streamed log. No automated UI test (matches `RegressionView`, which also has none) — verified manually in Task 13.

- [ ] **Step 1: Read `RegressionView.swift` in full**

Run: `sed -n '1,400p' mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift` (and continue past 400 if the file is longer) to confirm the exact `HSplitView`/pane structure, environment objects, and styling conventions (fonts, spacing, `theme` usage) before writing `LoopEngineView`, so the new page matches the app's established look rather than inventing a new one.

- [ ] **Step 2: Write `LoopEngineView`**

```swift
// mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift
import SwiftUI

struct LoopEngineView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore

    @State private var stages: [LoopStage] = []
    @State private var maxIterations: Int = 5
    @State private var consecutiveFailureStop: Int = 2
    @State private var selectedStageId: String?
    @State private var runner: LoopEngineRunner?
    @State private var running = false
    @State private var log: [LoopEngineRunner.LogLine] = []
    @State private var lastStatus: LoopEngineStatus?

    private let approvals = VerifyApprovalStore()

    var body: some View {
        HSplitView {
            stagesPane
                .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)
            detailPane
                .frame(minWidth: 320, maxWidth: .infinity)
            logPane
                .frame(minWidth: 260, idealWidth: 320, maxWidth: 420)
        }
        .navigationTitle("Loop Engineering")
        .onAppear(perform: loadConfig)
    }

    private var stagesPane: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Stages").font(.headline)
                Spacer()
                Button {
                    stages.append(LoopStage(name: "New Stage", kind: .shellCommand, command: "", order: stages.count))
                } label: { Image(systemName: "plus") }
            }
            List(stages.sorted(by: { $0.order < $1.order }), selection: $selectedStageId) { stage in
                HStack {
                    Image(systemName: stage.kind == .regressionSweep ? "arrow.uturn.backward.circle" : "terminal")
                    Text(stage.name)
                    Spacer()
                    if stage.kind == .shellCommand, let command = stage.command,
                       let gitRoot = activeGitRootURL,
                       !approvals.isStageApproved(repo: gitRoot, stageId: stage.id, command: command) {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    }
                }
                .tag(stage.id)
            }
            Divider()
            Stepper("Max iterations: \(maxIterations)", value: $maxIterations, in: 1...20)
            Stepper("Stop after \(consecutiveFailureStop) identical failures", value: $consecutiveFailureStop, in: 1...10)
            Button("Save") { saveConfig() }
        }
        .padding(8)
    }

    private var detailPane: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let id = selectedStageId, let index = stages.firstIndex(where: { $0.id == id }) {
                stageDetail(index: index)
            } else {
                Text("Select a stage").foregroundStyle(.secondary)
            }
            Spacer()
            HStack {
                Button(running ? "Running…" : "Run") { Task { await runLoop() } }
                    .disabled(running || stages.isEmpty)
                if let lastStatus {
                    Text(describe(lastStatus)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
    }

    private func stageDetail(index: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Name", text: $stages[index].name)
            if stages[index].kind == .shellCommand {
                TextField("Command", text: Binding(
                    get: { stages[index].command ?? "" },
                    set: { stages[index].command = $0 }
                ))
                if let gitRoot = activeGitRootURL, let command = stages[index].command, !command.isEmpty {
                    let approved = approvals.isStageApproved(repo: gitRoot, stageId: stages[index].id, command: command)
                    Button(approved ? "Approved" : "Approve & enable") {
                        approvals.approveStage(repo: gitRoot, stageId: stages[index].id, command: command)
                    }
                    .disabled(approved)
                }
                Button("Remove Stage", role: .destructive) {
                    stages.remove(at: index)
                    selectedStageId = nil
                }
            }
        }
    }

    private var logPane: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(log) { line in
                    Text(line.text)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(line.level == .error ? .red : (line.level == .warn ? .orange : .primary))
                }
            }
            .padding(8)
        }
    }

    /// The stable llm-ide Project.id (`ProjectStore.ActiveProject` has no
    /// `.id` of its own — only `.bundle.id`; see the contract documented on
    /// `LoopEngineConfig.load`/`save` in Task 1). Do NOT use `localPath` or
    /// any repo-backend id here — this must match what Task 9's
    /// `runLoopEngineeringSweep` keys by, or the Auto Task and this page
    /// silently maintain two different configs for the same project.
    private var activeProjectId: String? { projectStore.activeProject?.bundle.id }
    private var activeGitRootURL: URL? {
        projectStore.activeProject.map { URL(fileURLWithPath: $0.localPath, isDirectory: true) }
    }

    private func loadConfig() {
        guard let projectId = activeProjectId else { return }
        if let saved = LoopEngineConfig.load(for: projectId) {
            stages = saved.stages
            maxIterations = saved.maxIterations
            consecutiveFailureStop = saved.consecutiveFailureStop
        } else if let gitRoot = activeGitRootURL {
            let detected = LoopStageDetector.detectDefaultStages(gitRoot: gitRoot)
            stages = detected
            LoopEngineConfig(stages: detected, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
                .save(for: projectId)
        }
    }

    private func saveConfig() {
        guard let projectId = activeProjectId else { return }
        LoopEngineConfig(stages: stages, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
            .save(for: projectId)
    }

    private func runLoop() async {
        guard let projectId = activeProjectId, let gitRoot = activeGitRootURL else { return }
        saveConfig()
        let projectConfig = LoopEngineConfig(stages: stages, maxIterations: maxIterations, consecutiveFailureStop: consecutiveFailureStop)
        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: CodeAssistJudge(api: api),
                                                verifier: ShellFaultVerifier(), repairer: AgentFaultRepairer(api: api))
        let newRunner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            approvals: approvals
        )
        runner = newRunner
        running = true
        // faultsRoot == gitRoot here (both `activeProject.localPath`) — the
        // "project IS the repo" case `RegressionRunner.run(at:)`'s own
        // same-root convenience overload already assumes. A project using
        // the clone-into-code layout (project root != git clone dir) isn't
        // distinguished by this page in v1; Task 9's unattended Auto Task
        // path is the one that resolves both roots separately via
        // `resolveBackendAndProject()`.
        await newRunner.run(config: projectConfig, faultsRoot: gitRoot, gitRoot: gitRoot)
        log = newRunner.log
        lastStatus = newRunner.status
        running = false
    }

    private func describe(_ status: LoopEngineStatus) -> String {
        switch status {
        case .success: return "Success"
        case .givenUp(.maxIterations): return "Gave up (max iterations)"
        case .givenUp(.repeatedFailure): return "Gave up (repeated failure)"
        case .needsApproval(let name): return "Needs approval: \(name)"
        case .error(let msg): return "Error: \(msg)"
        case .aborted: return "Aborted"
        }
    }
}
```

`ProjectStore.ActiveProject`'s real shape (verified against `mac/Sources/LlmIdeMac/Services/ProjectStore.swift`) is `{ bundle: Project, localPath: String }` — `bundle.id` is the stable id (from `Project.id` in `Models/Project.swift`), which is why `activeProjectId` above reads `.bundle.id`, not `.id`.

- [ ] **Step 3: Build**

Run: `cd mac && swift build --product LlmIdeMac`
Expected: builds clean (this also satisfies Task 10's deferred build check)

- [ ] **Step 4: Commit Task 10 + Task 11 together**

```bash
git add mac/Sources/LlmIdeMac/Services/ShellState.swift \
        mac/Sources/LlmIdeMac/Views/AppShell.swift \
        mac/Sources/LlmIdeMac/Views/HelpGuideView.swift \
        mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift
git commit -m "feat(mac): add Loop Engineering nav section, help topic, and LoopEngineView"
```

---

### Task 12: Chat integration — Loop Engineering action in `CodeAssistantPanel`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift` (or a new `+LoopEngine.swift` extension, following the file's existing `+Session.swift`/`+Agent.swift` split)

No existing slash-command dispatcher exists in this chat panel (confirmed — a toolbar/header action is used instead, not text parsing).

- [ ] **Step 1: Locate the panel's header/action row**

Run: `grep -n "var body\|HStack\|struct CodeAssistantPanel" mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift | head -30` and read the surrounding `body` implementation to find where existing header actions (e.g. the session picker, the agent/model picker mentioned by `showModelPicker`) are placed, so the new button matches their placement and styling exactly. This view was recently reorganized (see git log: "consolidate CodeAssistantPanel's low-risk @State into 4 objects") — read the current file fresh rather than assuming an older layout.

- [ ] **Step 2: Add a `CodeAssistantPanel+LoopEngine.swift` extension**

```swift
// mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift
import Foundation

extension CodeAssistantPanel {
    /// Starts a Loop Engineering run against the active project and appends
    /// its progress as a single assistant turn in the current chat history,
    /// updated live as the run's log grows. Mirrors how `RegressionRunner`
    /// already streams progress into `RegressionView`'s log pane, but
    /// surfaced in the chat transcript instead of a dedicated page.
    @MainActor
    func runLoopEngineeringFromChat(projectId: String, gitRoot: URL, language: String) async {
        let placeholderIndex = history.count
        history.append(LlmIdeAPIClient.CodeAssistTurn(role: .assistant, content: "Starting Loop Engineering…"))

        // `projectId` here is the stable Project.id (see the contract on
        // LoopEngineConfig.load/save from Task 1) — the same key Task 9's
        // Auto Task and Task 11's LoopEngineView use, so all three triggers
        // share one config per project. `gitRoot` doubles as `faultsRoot`
        // below (see Task 11's `runLoop()` comment on this same
        // same-root simplification).
        let loopConfig = LoopEngineConfig.load(for: projectId) ?? {
            let detected = LoopEngineConfig(stages: LoopStageDetector.detectDefaultStages(gitRoot: gitRoot))
            detected.save(for: projectId)
            return detected
        }()
        let prompter = CodeAssistPrompter(api: api, language: language)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: CodeAssistJudge(api: api),
                                                verifier: ShellFaultVerifier(), repairer: AgentFaultRepairer(api: api))
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api, language: language),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner)
        )

        let cancellable = runner.$log.sink { [weak runner] lines in
            guard runner != nil else { return }
            let text = lines.map(\.text).joined(separator: "\n")
            if placeholderIndex < history.count {
                history[placeholderIndex].content = text.isEmpty ? "Starting Loop Engineering…" : text
            }
        }

        await runner.run(config: loopConfig, faultsRoot: gitRoot, gitRoot: gitRoot)
        cancellable.cancel()

        if placeholderIndex < history.count {
            let finalText = runner.log.map(\.text).joined(separator: "\n")
            history[placeholderIndex].content = finalText
        }
    }
}
```

Because `LoopEngineRunner` is `@Published`-backed and `Combine`, this file needs `import Combine` at the top alongside `import Foundation`. Confirm `LlmIdeAPIClient.CodeAssistTurn`'s `role` accepts a `.assistant` case (check `enum CodeAssistRole` in `LlmIdeAPIClient+CodeAssist.swift`) before finalizing.

- [ ] **Step 3: Add the toolbar button**

Using the insertion point found in Step 1, add a button near the existing header actions. The project id MUST be `projectStore.activeProject?.bundle.id` (the stable `Project.id` — see the contract documented on `LoopEngineConfig.load`/`save` in Task 1; `ProjectStore.ActiveProject` has no bare `.id`, only `.bundle.id`) so this shares the same `LoopEngineConfig` as the Loop Engineering page (Task 11) and the Auto Task (Task 9) — using anything else (a path, a repo id) silently splits the config in three:

```swift
Button {
    guard let active = projectStore.activeProject else { return }
    let gitRoot = URL(fileURLWithPath: active.localPath, isDirectory: true)
    Task { await runLoopEngineeringFromChat(projectId: active.bundle.id, gitRoot: gitRoot, language: /* panel's current language, found in Step 1 */) }
} label: {
    Label("Run Loop Engineering", systemImage: "repeat.circle")
}
```

Replace the remaining `/* ... */` placeholder using whatever the panel's existing actions already use for the current chat language — do not invent a new resolution path if one already exists in this file.

- [ ] **Step 4: Build**

Run: `cd mac && swift build --product LlmIdeMac`
Expected: builds clean once Step 3's placeholders are filled from the real surrounding code

- [ ] **Step 5: Manual verification**

Open the app, open a project's Code Assistant chat, click "Run Loop Engineering," confirm a chat message appears and updates as stages run, and that the final message states the stop reason.

- [ ] **Step 6: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+LoopEngine.swift \
        mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift
git commit -m "feat(mac): add Loop Engineering action to the Code Assistant chat panel"
```

---

### Task 13: Full regression pass + manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Swift suite**

Run: `cd mac && swift build --product LlmIdeMac && swift test`
Expected: all tests pass, including every test added in Tasks 1–9

- [ ] **Step 2: Manual — Auto Task path**

In the running app: Settings → Auto Tasks → enable "Loop Engineering" for a test project with a deliberately failing test. Trigger a manual run (or wait for its cron). Confirm: the Loop Engineering row shows progress, `ActivityBell` records a `loopEngineeringDone` entry, and the outcome (success or given-up) matches what the test's actual state should produce.

- [ ] **Step 3: Manual — Loop Engineering page**

Navigate to the new "Loop Engineering" section. Confirm the stage list auto-detected on first visit, approve the Test stage's command, click Run, and watch the log pane stream.

- [ ] **Step 4: Manual — Chat path**

From Task 12's verification, confirm the same run is triggerable from the Code Assistant chat and its outcome matches the Auto Task/page paths.

- [ ] **Step 5: Manual — mobile**

Pair an iPhone (or confirm via existing mobile test scripts) that "Loop Engineering" appears in the Auto Tasks list without any additional code, per `MobileControlManager.buildAutoTaskState()` already deriving from `AutoTask.allCases`.

- [ ] **Step 6: Final commit (if anything needed fixing during verification)**

```bash
git add -A
git commit -m "fix(mac): address issues found during Loop Engineering manual verification"
```

(Skip if verification found nothing to fix.)

---

## Self-Review Notes

- **Spec coverage:** every section of `2026-08-07-loop-engineering-design.md` maps to a task — Models (1), stage auto-detect (2), approval gate (3), stage repair (4), Regression-stage reuse (5), the runner/contract/stop-conditions (6), Auto Task integration (7–9), UI (10–11), chat (12), testing (13, plus per-task tests).
- **Known soft spots, called out explicitly rather than guessed:** Task 9 Step 3's `AutoCodeUpdateService` test constructor, Task 11's `ProjectStore` property names, and Task 12's exact header insertion point and active-repo/language resolution all depend on reading the real file at implementation time — each of those steps says so and tells the implementer exactly what to grep for, rather than presenting an unverified guess as fact.
- **Type consistency check:** `LoopStage`/`LoopEngineConfig` (Task 1) → consumed identically in `LoopStageDetector` (2), `LoopEngineRunner` (6), `runLoopEngineeringSweep` (9), and `LoopEngineView`/chat action (11–12). `LoopEngineStatus` cases (`success`, `givenUp(reason:)`, `needsApproval(stageName:)`, `error`, `aborted`) are used with the same associated values everywhere they appear. `VerifyApprovalStore.isStageApproved`/`approveStage` (3) are the only approval entry points used by both `LoopEngineRunner` and `LoopEngineView`.
