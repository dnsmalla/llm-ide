import XCTest
@testable import LlmIdeMacLib

/// Tests for the failure-surfacing and regression-summary helpers used by the
/// built-in pipeline task bodies in `AutoCodeUpdateService+PipelineTasks.swift`.
///
/// The task bodies themselves are hard to drive end-to-end (they need a temp
/// SQLite meeting index, a git working tree, and live GitHub/GitLab backends),
/// so these tests cover the PURE decision helpers the bodies delegate to:
/// the accumulate-then-surface pattern that prevents the "clear
/// `taskErrors[key]` unconditionally at the end" bug that was silently
/// swallowing partial failures, and the fail-closed regression summary.
@MainActor
final class AutoCodeUpdateServicePipelineTasksTests: XCTestCase {

    // MARK: - Fix 1: runSourcesToIssue failure surfacing

    func testTaskErrorFromFailures_nilWhenEmpty() {
        XCTAssertNil(AutoCodeUpdateService.taskErrorFromFailures([]))
    }

    func testTaskErrorFromFailures_joinedWhenNonEmpty() {
        XCTAssertEqual(AutoCodeUpdateService.taskErrorFromFailures(["boom"]), "boom")
        XCTAssertEqual(AutoCodeUpdateService.taskErrorFromFailures(["a", "b"]), "a · b")
    }

    // MARK: - Fix 2: runImplementIssues failure surfacing

    func testImplementIssuesErrorMessage_nilWhenNoneFailed() {
        XCTAssertNil(AutoCodeUpdateService.implementIssuesErrorMessage(failedCount: 0))
    }

    func testImplementIssuesErrorMessage_countMessageWhenSomeFailed() {
        XCTAssertEqual(
            AutoCodeUpdateService.implementIssuesErrorMessage(failedCount: 1),
            "1 issue(s) failed — see log")
        XCTAssertEqual(
            AutoCodeUpdateService.implementIssuesErrorMessage(failedCount: 3),
            "3 issue(s) failed — see log")
    }

    // MARK: - Fix 3: runRegressionSweep fail-closed summary

    /// All-passing verdicts → green summary, no error signaled.
    func testRegressionSweepSummary_allPassing_isGreen() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            verdicts: [.unchanged, .repaired], autoReopen: false)
        XCTAssertFalse(s.shouldSignalError)
        XCTAssertTrue(s.logLine.contains("no regressions"), "was: \(s.logLine)")
    }

    /// A `.regressed` fault has always flipped the card red — this case
    /// worked before the fix and must keep working.
    func testRegressionSweepSummary_regressed_signalsError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            verdicts: [.unchanged, .regressed], autoReopen: false)
        XCTAssertTrue(s.shouldSignalError)
        XCTAssertTrue(s.logLine.contains("regressed"), "was: \(s.logLine)")
    }

    /// THE BUG: a fault that came back `.failed` (CLI/network error — the
    /// check couldn't even run) used to be ignored, so a run where every
    /// fixed fault was `.failed` reported "no regressions". Must be fail-closed.
    func testRegressionSweepSummary_failedSignalsError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            verdicts: [.failed("boom"), .failed("boom2")], autoReopen: false)
        XCTAssertTrue(s.shouldSignalError, "every fault .failed must not be a false green")
    }

    /// A fault awaiting command approval also couldn't be verified — must
    /// signal an error, not stay silent.
    func testRegressionSweepSummary_needsApprovalSignalsError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            verdicts: [.needsApproval, .unchanged], autoReopen: true)
        XCTAssertTrue(s.shouldSignalError)
    }

    /// `.repairFailed` and `.pending` are also non-passing — fail-closed.
    func testRegressionSweepSummary_repairFailedAndPendingSignalError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            verdicts: [.repairFailed("x"), .pending], autoReopen: false)
        XCTAssertTrue(s.shouldSignalError)
    }

    func testRegressionSweepSummary_emptyIsGreen() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            verdicts: [], autoReopen: false)
        XCTAssertFalse(s.shouldSignalError)
        XCTAssertTrue(s.logLine.contains("No fixed faults"), "was: \(s.logLine)")
    }
}
