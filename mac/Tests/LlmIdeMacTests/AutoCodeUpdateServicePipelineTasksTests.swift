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
            outcome: .tally([.unchanged, .repaired]), autoReopen: false)
        XCTAssertFalse(s.shouldSignalError)
        XCTAssertTrue(s.logLine.contains("no regressions"), "was: \(s.logLine)")
    }

    /// A `.regressed` fault has always flipped the card red — this case
    /// worked before the fix and must keep working.
    func testRegressionSweepSummary_regressed_signalsError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            outcome: .tally([.unchanged, .regressed]), autoReopen: false)
        XCTAssertTrue(s.shouldSignalError)
        XCTAssertTrue(s.logLine.contains("regressed"), "was: \(s.logLine)")
    }

    /// THE BUG: a fault that came back `.failed` (CLI/network error — the
    /// check couldn't even run) used to be ignored, so a run where every
    /// fixed fault was `.failed` reported "no regressions". Must be fail-closed.
    func testRegressionSweepSummary_failedSignalsError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            outcome: .tally([.failed("boom"), .failed("boom2")]), autoReopen: false)
        XCTAssertTrue(s.shouldSignalError, "every fault .failed must not be a false green")
    }

    /// A fault awaiting command approval also couldn't be verified — must
    /// signal an error, not stay silent.
    func testRegressionSweepSummary_needsApprovalSignalsError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            outcome: .tally([.needsApproval, .unchanged]), autoReopen: true)
        XCTAssertTrue(s.shouldSignalError)
    }

    /// `.repairFailed` and `.pending` are also non-passing — fail-closed.
    func testRegressionSweepSummary_repairFailedAndPendingSignalError() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            outcome: .tally([.repairFailed("x"), .pending]), autoReopen: false)
        XCTAssertTrue(s.shouldSignalError)
    }

    func testRegressionSweepSummary_emptyIsGreen() {
        let s = AutoCodeUpdateService.regressionSweepSummary(
            outcome: .tally([]), autoReopen: false)
        XCTAssertFalse(s.shouldSignalError)
        XCTAssertTrue(s.logLine.contains("No fixed faults"), "was: \(s.logLine)")
    }

    // MARK: - Fix 4: reportKnowledge clears a stale taskErrors entry on the no-repo path

    private func makeService() -> AutoCodeUpdateService {
        let suite = UserDefaults(suiteName: "autotask-pipeline-\(UUID().uuidString)")!
        return AutoCodeUpdateService(
            config: AppConfig(userDefaults: suite),
            autoTaskSettings: AutoTaskSettings(defaults: suite),
            registry: ProcessedActionsRegistry(
                storeURL: URL(fileURLWithPath: "/tmp/llm-ide-test-registry-\(UUID().uuidString).json")),
            api: LlmIdeAPIClient(baseURL: "http://127.0.0.1:3456"),
            logStore: TaskLogStore())
    }

    func testReportKnowledgeClearsStaleTaskErrorWhenNothingToGraph() {
        let service = makeService()
        let key = AutoTask.generateKnowledge.rawValue
        service.taskErrors[key] = "stale error from a prior run"

        // An empty temp dir has no code/ child and holds no source, so
        // GraphAutoUpdater.repoToGraph returns nil → the early-return path.
        let emptyProject = FileManager.default.temporaryDirectory
            .appendingPathComponent("autotask-gk-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: emptyProject, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: emptyProject) }

        service.reportKnowledge(projectRoot: emptyProject.path)

        XCTAssertNil(service.taskErrors[key],
                     "no-repo path must clear a stale taskErrors entry, not leave it red")
    }

    // MARK: - Implement approval gate

    private func issue(labels: [String]) -> RepoIssue {
        RepoIssue(id: "1", number: 1, title: "Issue 1", body: nil, state: "opened", labels: labels,
                  milestone: nil, assignees: [],
                  author: RepoUser(id: "u1", username: "alice", displayName: "Alice", avatarUrl: nil),
                  createdAt: "2026-10-16T00:00:00Z",
                  updatedAt: "2026-10-16T00:00:00Z", closedAt: nil, webUrl: "https://example.test/i/1",
                  commentCount: 0, dueDate: nil, weight: nil)
    }

    /// Issues filed from ingested text (email, Slack, notes) reach an
    /// unattended agent with a shell only after a human labels them.
    func testImplementRequiresTheApprovalLabel() {
        XCTAssertFalse(AutoCodeUpdateService.isApprovedForImplementation(issue(labels: [])))
        XCTAssertFalse(AutoCodeUpdateService.isApprovedForImplementation(issue(labels: ["bug", "approved"])))
        XCTAssertTrue(AutoCodeUpdateService.isApprovedForImplementation(issue(labels: ["bug", "llmide:approved"])))
        XCTAssertTrue(AutoCodeUpdateService.isApprovedForImplementation(issue(labels: ["LLMIDE:Approved"])))
    }

    @MainActor
    func testSourceIssueBodyTellsTheReaderHowToApprove() {
        let body = AutoCodeUpdateService.sourceIssueBody(actionText: "Fix login", meetingTitle: "Standup")
        XCTAssertTrue(body.contains(AutoCodeUpdateService.implementApprovalLabel))
    }
}
