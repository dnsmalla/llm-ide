# Loop Engineering as the permanent home for regression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Loop Engineering the single, permanent, non-hideable home for regression: it runs the regression sweep and loops until all faults pass (or gives up clearly with counts), and the standalone Regression menu/page/setting is deleted entirely.

**Architecture:** Loop Engineering already loops (`LoopEngineRunner` iteration loop). The work is (1) widen the sweep seam from `Bool` to a counts struct so the runner can log counts and detect a stall, (2) add a `.regressionStalled` give-up + raise the default cap, (3) pin Loop Engineering as non-hideable, (4) delete the `.regression` nav case + `RegressionView` + help topic and repoint the one menu-bar status pill that referenced it. `RegressionRunner` + adapter stay — Loop Engineering depends on them.

**Tech Stack:** Swift 5 (SwiftUI, `@Observable`), SPM package at `mac/`, XCTest (`@testable import LlmIdeMacLib`, `@MainActor` test classes). Build/test from the `mac/` directory.

## Global Constraints

- All work is in the `mac/` SPM package. Build: `cd mac && swift build`. Test: `cd mac && swift test`.
- Test framework is **XCTest** (`import XCTest`, `@testable import LlmIdeMacLib`). Tests that touch `@MainActor` types are annotated `@MainActor final class …: XCTestCase` — follow that pattern.
- **Conventional Commits**, one concern per commit (`refactor(mac):`, `feat(mac):`, `test(mac):`). End every commit message with a blank line then `Co-Authored-By: Claude <noreply@anthropic.com>`.
- **Do all work on a feature branch**, not `main`. Create it in Task 0. Do **not** push — the repo's pre-push hook runs `swift build` + `swift test` and a premature push can deadlock on the `.build` lock; the user pushes at the end.
- `ShellState.Section` is `String, Hashable, CaseIterable` with exhaustive switches and no `default:` — removing an enum case is compiler-checked: any missed switch site is a build error (the safety net).
- Do not delete `RegressionRunner` or `RegressionRunnerSweepAdapter`; do not touch `AutoTask.regression` or the `.regressionDone` activity kind.

---

## Task 0: Create the feature branch

**Files:** none

- [ ] **Step 1: Branch off `main`**

Run:
```bash
cd /Users/dinsmallade/llm-ide
git checkout main
git pull --ff-only origin main 2>/dev/null || true
git checkout -b feat/loop-engineering-regression-home
```
Expected: `Switched to a new branch 'feat/loop-engineering-regression-home'`.

- [ ] **Step 2: Confirm a clean build/test baseline**

Run:
```bash
cd mac && swift build && swift test
```
Expected: build succeeds; all existing tests pass. (If the tree is already dirty from earlier session work, stash or commit it first — do not build on top of a broken tree.)

---

## Task 1: Widen the regression-sweep seam to expose counts (`SweepOutcome`)

Pure, behavior-preserving refactor: the sweep returns a counts struct instead of a bare `Bool`. No behavior change yet (counts are not consumed for control flow). This unblocks Tasks 2 and 3.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/RegressionSweepRunning.swift`
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift:148-150`
- Modify: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift:58-73` (`StubRegressionSweep`)
- Modify: `mac/Tests/LlmIdeMacTests/RegressionRunnerSweepAdapterTests.swift` (4 methods)

**Interfaces:**
- Produces: `SweepOutcome` (struct, `Equatable`) and `RegressionSweepRunning.sweep(faultsRoot:gitRoot:attemptRepair:) async -> SweepOutcome`. Tasks 2 and 3 consume `outcome.regressed`, `outcome.passed`, `outcome.unchanged`, `outcome.repaired`, `outcome.total`.

- [ ] **Step 1: Update the adapter tests to the new contract (red — won't compile until Step 3)**

In `mac/Tests/LlmIdeMacTests/RegressionRunnerSweepAdapterTests.swift`, change each of the four test methods from `let passed = await adapter.sweepPassed(...)` + `XCTAssertTrue/False(passed)` to `let outcome = await adapter.sweep(...)` + assert `outcome.passed`, and add a count assertion to the two verdict-specific tests.

Replace the assertion lines in `testSweepPassedTrueWhenNoFixedFaultsExist`:
```swift
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: true)
        XCTAssertTrue(outcome.passed)
        XCTAssertEqual(outcome.total, 0)
```

Replace the assertion lines in `testSweepPassedFalseWhenAFaultCouldNotBeChecked`:
```swift
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertFalse(outcome.passed)
        XCTAssertEqual(outcome.failed, 1)
```

Replace the assertion lines in `testSweepPassedTrueForAnActualUnchangedVerdict`:
```swift
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertTrue(outcome.passed)
        XCTAssertEqual(outcome.unchanged, 1)
        XCTAssertEqual(outcome.total, 1)
```

Replace the assertion lines in `testSweepPassedFalseForARegressedVerdict`:
```swift
        let outcome = await adapter.sweep(faultsRoot: tempDir, gitRoot: tempDir, attemptRepair: false)
        XCTAssertFalse(outcome.passed)
        XCTAssertEqual(outcome.regressed, 1)
        XCTAssertEqual(outcome.total, 1)
```

- [ ] **Step 2: Update the test double (red)**

In `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`, replace the `StubRegressionSweep` class (lines 58-73) with one that returns `SweepOutcome`:
```swift
    private final class StubRegressionSweep: RegressionSweepRunning {
        var alwaysPasses: Bool
        /// Invoked synchronously on every `sweep` call, before
        /// returning. Lets a test inject a side effect (e.g. cancelling
        /// the enclosing `Task`) at the exact moment the runner is
        /// mid-stage, rather than only before/after a run.
        var onSweep: (() -> Void)?
        init(alwaysPasses: Bool, onSweep: (() -> Void)? = nil) {
            self.alwaysPasses = alwaysPasses
            self.onSweep = onSweep
        }
        func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome {
            onSweep?()
            return alwaysPasses
                ? SweepOutcome(passed: true, total: 0, regressed: 0, unchanged: 0,
                               repaired: 0, repairFailed: 0, needsApproval: 0,
                               failed: 0, pending: 0)
                : SweepOutcome(passed: false, total: 1, regressed: 1, unchanged: 0,
                               repaired: 0, repairFailed: 0, needsApproval: 0,
                               failed: 0, pending: 0)
        }
    }
```

- [ ] **Step 3: Add `SweepOutcome`, rename the protocol method, rewrite the adapter (green)**

Replace the entire contents of `mac/Sources/LlmIdeMac/Services/LoopEngine/RegressionSweepRunning.swift` with:
```swift
import Foundation

/// Per-sweep outcome: a pass/fail verdict plus the verdict-count breakdown
/// the runner needs to (a) log human-readable progress and (b) detect a
/// stall (regressed count not shrinking across iterations). The seam
/// `LoopEngineRunner` depends on instead of `RegressionRunner` directly,
/// so its own tests can fake this stage in isolation.
struct SweepOutcome: Equatable {
    let passed: Bool
    let total: Int
    let regressed: Int
    let unchanged: Int
    let repaired: Int
    let repairFailed: Int
    let needsApproval: Int
    let failed: Int
    let pending: Int
}

protocol RegressionSweepRunning {
    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome
}

/// Production adapter wrapping the real `RegressionRunner`. A sweep
/// "passes" when no fault came back `.regressed`, `.repairFailed`,
/// `.needsApproval`, `.failed`, or `.pending` — `.unchanged` and
/// `.repaired` both count as passing. `.failed` (a CLI/network error —
/// the check couldn't even run) and `.pending` (a fault never reached
/// during a cancelled sweep) are both treated as not-passed rather
/// than silently ignored: fail-closed on ambiguity, matching
/// `VerifyApprovalStore`'s stance elsewhere in this codebase. The
/// verdict switch below is intentionally exhaustive (no `default:`)
/// so a future `Verdict` case can't silently fall into "not failing."
///
/// Owns `runner` exclusively: callers must hand this adapter a
/// dedicated `RegressionRunner` it alone drives. Passing in a runner
/// another caller might concurrently invoke `run()` on is unsupported
/// — `sweep` guards against re-entrancy on this instance but a runner
/// shared across two adapters/callers is still a hazard, since
/// `RegressionRunner.run()` no-ops (leaving stale `results`) when it's
/// already running.
@MainActor
final class RegressionRunnerSweepAdapter: RegressionSweepRunning {
    private let runner: RegressionRunner

    init(runner: RegressionRunner) {
        self.runner = runner
    }

    func sweep(faultsRoot: URL, gitRoot: URL?, attemptRepair: Bool) async -> SweepOutcome {
        // `RegressionRunner.run()` guards re-entrancy by no-op-returning
        // without resetting `results` — reading that stale/partial state
        // would silently report a pass. Refuse instead (fail-closed).
        guard !runner.running else {
            return SweepOutcome(passed: false, total: 0, regressed: 0, unchanged: 0,
                                 repaired: 0, repairFailed: 0, needsApproval: 0,
                                 failed: 0, pending: 0)
        }
        await runner.run(faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: attemptRepair)

        var regressed = 0, unchanged = 0, repaired = 0
        var repairFailed = 0, needsApproval = 0, failed = 0, pending = 0
        for result in runner.results {
            switch result.verdict {
            case .pending:        pending += 1
            case .unchanged:      unchanged += 1
            case .regressed:      regressed += 1
            case .repaired:       repaired += 1
            case .repairFailed:   repairFailed += 1
            case .needsApproval:  needsApproval += 1
            case .failed:         failed += 1
            }
        }
        let nonPassing = regressed + repairFailed + needsApproval + failed + pending
        return SweepOutcome(passed: nonPassing == 0,
                            total: runner.results.count,
                            regressed: regressed, unchanged: unchanged, repaired: repaired,
                            repairFailed: repairFailed, needsApproval: needsApproval,
                            failed: failed, pending: pending)
    }
}
```

- [ ] **Step 4: Update the runner call site (minimal, behavior-preserving)**

In `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`, replace the `.regressionSweep` branch (lines 148-158) with:
```swift
                case .regressionSweep:
                    let outcome = await regressionSweep.sweep(
                        faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true)
                    let passed = outcome.passed
                    appendLog(passed ? .info : .warn, "  [\(stage.name)] \(passed ? "passed" : "failed")")
                    if !passed {
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        continue iterationLoop
                    }
```
(Control flow is identical to before; only the seam return type changed. Counts logging and stall detection are added in Tasks 2 and 3.)

- [ ] **Step 5: Build + run the affected tests**

Run:
```bash
cd mac && swift build && swift test --filter LoopEngineRunnerTests && swift test --filter RegressionRunnerSweepAdapterTests
```
Expected: build succeeds; both test suites pass. Critically, `testFailingRegressionStageRetriesWithoutCallingStageRepairer` still passes unchanged — the failing stub now reports a constant `regressed == 1`, and with `consecutiveFailureStop: 5, maxIterations: 2` the run still gives up via `.maxIterations` at iteration 2 (stall logic isn't added until Task 3).

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/LoopEngine/RegressionSweepRunning.swift \
        mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift \
        mac/Tests/LlmIdeMacTests/RegressionRunnerSweepAdapterTests.swift
git commit -m "refactor(mac): widen regression sweep seam to expose counts

Replace RegressionSweepRunning.sweepPassed(...) -> Bool with
sweep(...) -> SweepOutcome so the runner can see regressed/passed
counts. Behavior-preserving: the runner still keys control flow off
outcome.passed with the same fail-closed definition.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Surface regression counts in the run log

The regression branch now has `outcome`; replace the plain "passed/failed" log line with one showing `N regressed / M passed of T`.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift` (the `.regressionSweep` branch from Task 1, + a new private static helper)
- Test: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` (new test method)

**Interfaces:**
- Consumes: `SweepOutcome` from Task 1.
- Produces: a private static `LoopEngineRunner.regressionLine(_:)` helper (used again in Task 3).

- [ ] **Step 1: Add the failing test**

In `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`, add this test (e.g. right after `testFailingRegressionStageRetriesWithoutCallingStageRepairer`):
```swift
    func testRegressionBranchLogsRegressedAndPassedCounts() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 1, consecutiveFailureStop: 5)
        let runner = LoopEngineRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            approvals: makeApprovals()
        )
        _ = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        // The stub's failing outcome is total:1, regressed:1 → log line must
        // surface "1 regressed" and "of 1", not a bare "failed".
        let regressionLines = runner.log.filter { $0.text.contains("[Regression]") }
        XCTAssertFalse(regressionLines.isEmpty)
        XCTAssertTrue(regressionLines.contains { $0.text.contains("1 regressed") })
        XCTAssertTrue(regressionLines.contains { $0.text.contains("of 1") })
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && swift test --filter testRegressionBranchLogsRegressedAndPassedCounts`
Expected: FAIL — the current line is `[Regression] failed` with no counts.

- [ ] **Step 3: Add the helper and use it in the branch**

In `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`, change the log line inside the `.regressionSweep` branch from:
```swift
                    appendLog(passed ? .info : .warn, "  [\(stage.name)] \(passed ? "passed" : "failed")")
```
to:
```swift
                    appendLog(outcome.passed ? .info : .warn,
                              "  [\(stage.name)] \(Self.regressionLine(outcome))")
```
Then add this private static helper to the `LoopEngineRunner` class (e.g. just above `private func appendLog`):
```swift
    /// One-line, human-readable regression-sweep result for the run log:
    /// either "passed — M of T" or "failed — R regressed / M passed of T".
    /// M = faults that still hold (.unchanged + .repaired).
    private static func regressionLine(_ outcome: SweepOutcome) -> String {
        let passedCount = outcome.unchanged + outcome.repaired
        if outcome.passed {
            return "passed — \(passedCount) of \(outcome.total)"
        }
        return "failed — \(outcome.regressed) regressed / \(passedCount) passed of \(outcome.total)"
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mac && swift test --filter testRegressionBranchLogsRegressedAndPassedCounts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "feat(mac): show regression counts in Loop Engineering run log

The regression-sweep stage now logs 'N regressed / M passed of T'
instead of a bare 'failed', so 'all pass' is visible mid-run.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Give up early when regressions stop shrinking (`.regressionStalled`)

Mirror the shell stage's `consecutiveFailureStop`: if the regressed count does not decrease vs. the previous iteration for `consecutiveFailureStop` consecutive observations, give up with a new precise reason instead of burning the remaining cap.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineStatus.swift` (new `GivenUpReason` case + summary line)
- Modify: `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift` (stall state + branch logic)
- Test: `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift` (new test)

**Interfaces:**
- Produces: `LoopEngineStatus.GivenUpReason.regressionStalled` and summary `"given up (regressions stopped shrinking)"`. Consumed by `AutoCodeUpdateService+PipelineTasks.swift` via `.summary` (no change needed there).

- [ ] **Step 1: Add the failing test**

In `mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift`, add:
```swift
    func testRegressionStallGivesUpBeforeMaxIterations() async {
        let repairer = StubRepairer()
        let verifier = StubVerifier { _ in VerifyOutcome(exitCode: 0, output: "") }
        // The stub always reports regressed == 1 (never decreases), so with
        // consecutiveFailureStop: 2 the run should stall before maxIterations.
        let config = LoopEngineConfig(stages: [
            LoopStage(id: "r1", name: "Regression", kind: .regressionSweep, command: nil, order: 0)
        ], maxIterations: 10, consecutiveFailureStop: 2)
        let runner = LoopEngineRunner(
            verifier: verifier,
            stageRepairer: repairer,
            regressionSweep: StubRegressionSweep(alwaysPasses: false),
            approvals: makeApprovals()
        )
        let result = await runner.run(config: config, faultsRoot: repoRoot, gitRoot: repoRoot)
        XCTAssertEqual(result, .givenUp(reason: .regressionStalled))
        XCTAssertEqual(runner.status, .givenUp(reason: .regressionStalled))
        // Iteration 1 sets the baseline (count 1); iteration 2 reaches
        // consecutiveFailureStop → stalls. Mirrors the shell stage's
        // testConsecutiveIdenticalFailuresGivesUpBeforeMaxIterations.
        XCTAssertEqual(runner.iteration, 2)
        XCTAssertEqual(repairer.repairCount, 0)
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd mac && swift test --filter testRegressionStallGivesUpBeforeMaxIterations`
Expected: FAIL — `.regressionStalled` does not exist (compile error) / the run currently gives up `.maxIterations` at iteration 10.

- [ ] **Step 3: Add the new give-up reason + summary**

In `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineStatus.swift`, add the case to `GivenUpReason`:
```swift
    enum GivenUpReason: Equatable {
        case maxIterations
        case repeatedFailure
        case regressionStalled
    }
```
and add a summary line (keep the existing two, add this one):
```swift
        case .givenUp(.regressionStalled): return "given up (regressions stopped shrinking)"
```

- [ ] **Step 4: Add stall state + branch logic**

In `mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift`, declare the stall state alongside the existing `failureState` (line 130). Add after that line:
```swift
        // Regression-stall tracking: the regressed count from the previous
        // iteration, and how many consecutive iterations it has failed to
        // decrease. Mirrors the shell stage's per-stage `failureState` but
        // for the single regression stage (count starts at 1 on first
        // failure, same as the shell path).
        var lastRegressed: Int? = nil
        var regressionStallCount = 0
```

Then replace the whole `.regressionSweep` branch (the version from Task 2) with:
```swift
                case .regressionSweep:
                    let outcome = await regressionSweep.sweep(
                        faultsRoot: faultsRoot, gitRoot: gitRoot, attemptRepair: true)
                    appendLog(outcome.passed ? .info : .warn,
                              "  [\(stage.name)] \(Self.regressionLine(outcome))")
                    if outcome.passed {
                        // A pass restarts the stall watch so a later failure
                        // in the same run counts from scratch.
                        lastRegressed = nil
                        regressionStallCount = 0
                    } else {
                        if let prev = lastRegressed, outcome.regressed >= prev {
                            regressionStallCount += 1
                        } else {
                            regressionStallCount = 1
                        }
                        lastRegressed = outcome.regressed
                        if regressionStallCount >= config.consecutiveFailureStop {
                            status = .givenUp(reason: .regressionStalled)
                            break iterationLoop
                        }
                        if iteration >= config.maxIterations {
                            status = .givenUp(reason: .maxIterations)
                            break iterationLoop
                        }
                        continue iterationLoop
                    }
```
Note: every give-up path uses `break iterationLoop`, so the existing final cancellation re-check (lines ~233-242) still overrides to `.aborted` when a cancellation races — the cancellation tests stay green.

- [ ] **Step 5: Run the new test + the full runner suite**

Run: `cd mac && swift test --filter LoopEngineRunnerTests`
Expected: PASS — including the new stall test AND all pre-existing tests:
- `testFailingRegressionStageRetriesWithoutCallingStageRepairer` (`consecutiveFailureStop: 5, maxIterations: 2`) still gives up `.maxIterations` at iteration 2 — stall count only reaches 2, below 5.
- `testCancelledRegressionSweepOnlyRunMapsToAborted` and the other `onSweep` cancellation test still report `.aborted` — iteration 1 never stalls (`lastRegressed` is nil → count reset to 1), so the loop reaches the top-of-iteration cancellation check / final re-check.

- [ ] **Step 6: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineStatus.swift \
        mac/Sources/LlmIdeMac/Services/LoopEngine/LoopEngineRunner.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineRunnerTests.swift
git commit -m "feat(mac): stop Loop Engineering early when regressions stall

Add .regressionStalled give-up reason: if the regressed count does
not decrease for consecutiveFailureStop consecutive iterations, the
run gives up instead of burning the remaining cap. Mirrors the
shell stage's existing consecutiveFailureStop.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Raise the default iteration cap 5 → 10

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift:10` (struct default)
- Modify: `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift:51` (`@State` default) and `:421` (`resetStagesToDefaults`)
- Test: `mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift:48-52`

**Interfaces:** none new.

- [ ] **Step 1: Update the default test (red)**

In `mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift`, rename and update the default test:
```swift
    func testDefaultsAreTenAndTwo() {
        let config = LoopEngineConfig(stages: [])
        XCTAssertEqual(config.maxIterations, 10)
        XCTAssertEqual(config.consecutiveFailureStop, 2)
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && swift test --filter testDefaultsAreTenAndTwo`
Expected: FAIL — `config.maxIterations` is still 5.

- [ ] **Step 3: Raise the three defaults**

In `mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift:10`, change:
```swift
    var maxIterations: Int = 5
```
to:
```swift
    var maxIterations: Int = 10
```

In `mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift:51`, change:
```swift
    @State private var maxIterations: Int = 5
```
to:
```swift
    @State private var maxIterations: Int = 10
```

In the same file, in `resetStagesToDefaults` (line ~419-423), change:
```swift
        maxIterations = 5
```
to:
```swift
        maxIterations = 10
```
(Leave `consecutiveFailureStop = 2` unchanged. The `Stepper` range is already `1...20`, so 10 is valid.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mac && swift test --filter LoopEngineConfigTests`
Expected: PASS. (Note: `testDifferentProjectsDoNotShareConfig` constructs `maxIterations: 5` explicitly — that literal stays valid and unchanged.)

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Models/LoopEngine/LoopEngineConfig.swift \
        mac/Sources/LlmIdeMac/Views/LoopEngine/LoopEngineView.swift \
        mac/Tests/LlmIdeMacTests/LoopEngineConfigTests.swift
git commit -m "feat(mac): raise Loop Engineering default iteration cap to 10

New Loop configs now loop up to 10 iterations by default (was 5)
across the struct default, the view's @State, and
resetStagesToDefaults. Existing persisted configs keep their value.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Lock the default regression-sweep stage invariant

`LoopStageDetector.detectDefaultStages` already seeds a `.regressionSweep` stage unconditionally (confirmed: line 10). Add a test that locks that invariant so a future change can't silently remove the out-of-box "regression loop until pass."

**Files:**
- Modify: `mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift`

**Interfaces:** none.

- [ ] **Step 1: Add the failing test**

In `mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift`, add:
```swift
    func testDefaultStagesAlwaysIncludeARegressionSweepStage() {
        let empty = FileManager.default.temporaryDirectory
            .appendingPathComponent("detector-empty-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: empty) }

        let stages = LoopStageDetector.detectDefaultStages(gitRoot: empty)
        // Even with no detectable test tooling, a fresh project must get a
        // regression-sweep stage so Loop Engineering can "run regression
        // and loop until all pass" out of the box.
        XCTAssertTrue(stages.contains { $0.kind == .regressionSweep },
                      "default stages must always include a regressionSweep stage")
    }
```
(If the file's existing tests already create a temp dir helper, reuse it; otherwise the inline `empty` above is self-contained.)

- [ ] **Step 2: Run it**

Run: `cd mac && swift test --filter testDefaultStagesAlwaysIncludeARegressionSweepStage`
Expected: PASS immediately — the detector already seeds the stage. This test exists to prevent regression, not to drive new code.

- [ ] **Step 3: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Tests/LlmIdeMacTests/LoopStageDetectorTests.swift
git commit -m "test(mac): lock default regression-sweep stage invariant

LoopStageDetector already seeds a regressionSweep stage for every
project; pin that so Loop Engineering keeps 'run regression until
pass' as the out-of-box default.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Make Loop Engineering permanent (non-hideable)

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift:58-60` (`userHideable`)
- Test: `mac/Tests/LlmIdeMacTests/ShellStateSectionTests.swift` (new file)

**Interfaces:** none.

- [ ] **Step 1: Add the failing test (new file)**

Create `mac/Tests/LlmIdeMacTests/ShellStateSectionTests.swift`:
```swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class ShellStateSectionTests: XCTestCase {
    /// Loop Engineering is the permanent home for regression and must
    /// always be reachable — it can't be hidden via Settings like the
    /// ordinary tool sections.
    func testLoopEngineeringIsNotUserHideable() {
        XCTAssertFalse(
            ShellState.Section.userHideable.contains(.loopEngine),
            "Loop Engineering must not be user-hideable"
        )
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && swift test --filter testLoopEngineeringIsNotUserHideable`
Expected: FAIL — `.loopEngine` is still in `userHideable`.

- [ ] **Step 3: Remove `.loopEngine` from `userHideable`**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift:58-60`, change:
```swift
        static let userHideable: [Section] = [
            .explorer, .search, .conflicts, .sourceControl, .issues, .gantt, .visual, .docGen, .autoCode, .codeGraph, .regression, .loopEngine
        ]
```
to:
```swift
        static let userHideable: [Section] = [
            .explorer, .search, .conflicts, .sourceControl, .issues, .gantt, .visual, .docGen, .autoCode, .codeGraph, .regression
        ]
```
(`.regression` is removed in Task 7; leave it for now so this task compiles independently.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd mac && swift test --filter testLoopEngineeringIsNotUserHideable`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add mac/Sources/LlmIdeMac/Services/ShellState.swift \
        mac/Tests/LlmIdeMacTests/ShellStateSectionTests.swift
git commit -m "feat(mac): make Loop Engineering a permanent, non-hideable page

Remove .loopEngine from ShellState.Section.userHideable so it is
always present in the toolbar (like Library/Settings), as the single
home for regression.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Delete the standalone Regression page and repoint its one link

Remove the `.regression` nav case, `RegressionView`, its route arm, toolbar entry, hideable entry, the help topic, and repoint the menu-bar status pill (which currently links to `.regression`) at `.loopEngine`. The compiler enforces completeness (exhaustive switches, no `default:`).

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/ShellState.swift` (enum case + label/image/tint arms + userHideable)
- Modify: `mac/Sources/LlmIdeMac/Views/AppShell.swift` (`toolOrder` + route arm)
- Modify: `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift:581` (menu-bar pill)
- Modify: `mac/Sources/LlmIdeMac/Views/HelpGuideView.swift` (`HelpTopic.regression` case + 4 arms + `regressionContent`)
- Delete: `mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift`
- Test: `mac/Tests/LlmIdeMacTests/ShellStateSectionTests.swift` (extend)

**Interfaces:** none new. Removing `.regression` is the deliverable.

- [ ] **Step 1: Add the failing test (red — case still exists)**

Append to `mac/Tests/LlmIdeMacTests/ShellStateSectionTests.swift`, inside the class:
```swift
    /// The standalone Regression page is gone; the enum must no longer
    /// carry it and nothing should reference the retired raw value.
    func testRegressionSectionIsRetired() {
        XCTAssertNil(ShellState.Section(rawValue: "regression"))
        XCTAssertFalse(ShellState.Section.userHideable.contains { $0.rawValue == "regression" })
        XCTAssertFalse(ShellState.Section.allCases.contains { $0.rawValue == "regression" })
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd mac && swift test --filter testRegressionSectionIsRetired`
Expected: FAIL — `Section(rawValue: "regression")` still returns the case.

- [ ] **Step 3: Remove `.regression` from `ShellState.Section`**

In `mac/Sources/LlmIdeMac/Services/ShellState.swift`:
- Line 9 — remove `regression, ` from:
```swift
        case library, live, explorer, search, conflicts, sourceControl, issues, gantt, visual, docGen, autoCode, codeGraph, regression, loopEngine, settings
```
becomes:
```swift
        case library, live, explorer, search, conflicts, sourceControl, issues, gantt, visual, docGen, autoCode, codeGraph, loopEngine, settings
```
- Line 27 — delete the arm:
```swift
            case .regression: return "Regression"
```
- Line 47 — delete the arm:
```swift
            case .regression: return "arrow.uturn.backward.circle"
```
- Line 59 — in `userHideable`, remove `.regression, ` so it reads:
```swift
        static let userHideable: [Section] = [
            .explorer, .search, .conflicts, .sourceControl, .issues, .gantt, .visual, .docGen, .autoCode, .codeGraph
        ]
```
- Line 127 — delete the tint arm:
```swift
        case .regression: return Color(red: 0.40, green: 0.75, blue: 0.50) // mint-green
```

- [ ] **Step 4: Remove the toolbar entry and route arm**

In `mac/Sources/LlmIdeMac/Views/AppShell.swift`:
- Line 412 — remove `.regression, ` from `toolOrder`:
```swift
        .gantt, .loopEngine, .docGen, .visual, .library, .live,
```
- Line 607 — delete the route arm:
```swift
        case .regression: RegressionView(api: api)
```
(Leave `case .loopEngine: LoopEngineView(api: api)` on the next line.)

- [ ] **Step 5: Repoint the menu-bar status pill**

In `mac/Sources/LlmIdeMac/LlmIdeMacApp.swift:581`, change:
```swift
                    object: ShellState.Section.regression.rawValue
```
to:
```swift
                    object: ShellState.Section.loopEngine.rawValue
```
(The pill still reports `config.lastRegressionRunAt` / `lastRegressionRegressedCount`; it now opens Loop Engineering, the new home of regression. Pill label and styling are unchanged.)

- [ ] **Step 6: Remove the Regression help topic**

In `mac/Sources/LlmIdeMac/Views/HelpGuideView.swift`:
- In the `HelpTopic` enum (line ~596), delete:
```swift
    case regression
```
- Line 71 — delete the `topicContent` arm:
```swift
        case .regression:      regressionContent
```
- Line 621 — delete the `title` arm:
```swift
        case .regression:      return "Regression"
```
- Line 645 — delete the `icon` arm:
```swift
        case .regression:      return "arrow.uturn.backward.circle"
```
- Line 672 — delete the `tint` arm:
```swift
        case .regression:      return Color(red: 0.40, green: 0.75, blue: 0.50)
```
- Lines 354-366 — delete the now-unused `regressionContent` computed property in its entirety.
(The sidebar list is `HelpTopic.allCases` (line 15), so removing the case drops the row automatically.)

- [ ] **Step 7: Delete `RegressionView.swift`**

Run:
```bash
cd /Users/dinsmallade/llm-ide
git rm mac/Sources/LlmIdeMac/Views/Regression/RegressionView.swift
```
(Confirmed safe: the only construction site was the AppShell route arm removed in Step 4, and there are no references in `Tests/`. If the `Views/Regression/` directory is now empty, leave it — SPM doesn't require its removal.)

- [ ] **Step 8: Build the whole package — this is the completeness check**

Run: `cd mac && swift build`
Expected: build succeeds. Any missed switch site that still references `.regression` (in `ShellState` or `HelpTopic`) is a compile error — fix by removing that arm. If the build fails on an unexpected reference, grep for it: `grep -rn "\.regression" mac/Sources` and resolve (remember `AutoTask.regression`, `LoopStage.Kind.regressionSweep`, and `ActivityKind.regressionDone` are different enums and must NOT be touched).

- [ ] **Step 9: Run the full test suite**

Run: `cd mac && swift test`
Expected: PASS, including `testRegressionSectionIsRetired` and `testLoopEngineeringIsNotUserHideable`.

- [ ] **Step 10: Commit**

```bash
cd /Users/dinsmallade/llm-ide
git add -A mac/Sources mac/Tests
git commit -m "feat(mac): remove standalone Regression page, fold into Loop Engineering

Delete the .regression nav case, RegressionView, its toolbar entry
and route arm, its hideable entry, and its help topic. The menu-bar
regression status pill now opens Loop Engineering, the single home
for regression. RegressionRunner stays (Loop Engineering depends on
it).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Final verification + docs

**Files:** possibly `docs/` if any user-facing doc references the Regression page.

- [ ] **Step 1: Clean build + full test suite**

Run:
```bash
cd mac && swift build && swift test
```
Expected: build succeeds; all tests pass.

- [ ] **Step 2: Search docs for stale Regression-page references**

Run:
```bash
cd /Users/dinsmallade/llm-ide && grep -rln "Regression" docs --include="*.md" | head -30
```
For each hit, decide: if it documents the standalone Regression *page/menu* (now gone), update it to point at Loop Engineering; if it documents the regression *feature/run* (still exists, now under Loop Engineering), leave it or reword. Do not bulk-rewrite — check each.

- [ ] **Step 3: Manual smoke test (build the app and click)**

Run (from repo root): `cd mac && bash build_app.sh && open "$(find .build -name LlmIdeMac.app -type d | head -1)"` (or the project's standard launch path — see `running-mac-app-for-observation` memory). Grant Accessibility if prompted. Verify:
- No "Regression" button in the title-bar toolbar.
- "Loop Engineering" button is always present.
- Settings → "Menu Bar": no Regression toggle, no "Regression" in the "Home opens" picker, and no hide toggle for Loop Engineering.
- Open Loop Engineering with a project that has `status: fixed` fault reports → Run streams lines like `[Regression Sweep] failed — N regressed / M passed of T`; a persistently-regressing project stops early with "given up (regressions stopped shrinking)".
- The menu-bar "⚠ N regressions" status pill opens Loop Engineering (not a dead page).

- [ ] **Step 4: Commit any doc updates (if any)**

```bash
cd /Users/dinsmallade/llm-ide
git add docs
git commit -m "docs(mac): point Regression references at Loop Engineering

Co-Authored-By: Claude <noreply@anthropic.com>"
```
(Skip if Step 2 found nothing to change.)

---

## Self-review notes (for the implementer)

- **Spec coverage:** A (delete Regression) = Task 7; B (Loop Eng permanent) = Task 6; C (widen seam + default stage) = Tasks 1 + 5; D (show counts) = Task 2; E (stronger loop) = Tasks 3 + 4. The optional `homeSection: "regression"` migration from the spec is NOT included — once the `.regression` case is gone, a stored `homeSection: "regression"` fails `Section(rawValue:)` and `resolveHome` falls back to `.library` (safe). Add the migration only if a reviewer wants Loop Engineering specifically as the fallback.
- **Type consistency:** `SweepOutcome` fields are referenced identically across Tasks 1-3 (`passed`, `regressed`, `unchanged`, `repaired`, `total`). `regressionLine(_:)` is defined in Task 2 and reused in Task 3. `.regressionStalled` is defined and asserted consistently.
- **Existing-test safety:** Task 3's stall logic was traced against every existing regression-failure test (`testFailingRegressionStageRetriesWithoutCallingStageRepairer` and both `onSweep` cancellation tests) — none flip outcome, because iteration 1 never stalls and every give-up path `break iterationLoop`s into the final cancellation re-check.
