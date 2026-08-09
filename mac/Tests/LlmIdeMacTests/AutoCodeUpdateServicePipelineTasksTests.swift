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
}
