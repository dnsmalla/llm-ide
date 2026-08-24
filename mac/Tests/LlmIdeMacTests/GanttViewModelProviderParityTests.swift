import XCTest
@testable import LlmIdeMacLib

/// The Gantt is one view for GitLab and GitHub. That only works if the view
/// model normalises where the dates come from, because the providers differ:
///
///   • GitLab issues carry a native `dueDate`.
///   • GitHub issues carry none — our /kb/issue-schedule overlay supplies
///     start / due / estimate, and the adapter folds the milestone's due date
///     into `RepoIssue.dueDate` as the fallback.
///
/// These tests pin that precedence so a GitHub issue lands on the same bar a
/// GitLab issue with the same dates would, and so a scheduled issue is never
/// silently dropped from the chart.
@MainActor
final class GanttViewModelProviderParityTests: XCTestCase {

    // MARK: - Fixtures

    private func issue(number: Int,
                       state: String = "opened",
                       labels: [String] = [],
                       milestone: RepoMilestone? = nil,
                       assignees: [RepoUser] = [],
                       createdAt: String = "2026-01-01T00:00:00Z",
                       dueDate: String? = nil) -> RepoIssue {
        RepoIssue(
            id: "i\(number)", number: number, title: "Issue \(number)", body: nil,
            state: state, labels: labels, milestone: milestone, assignees: assignees,
            author: RepoUser(id: "u1", username: "alice", displayName: "Alice", avatarUrl: nil),
            createdAt: createdAt, updatedAt: createdAt, closedAt: nil,
            webUrl: "https://example.test/i/\(number)", commentCount: 0,
            dueDate: dueDate, weight: nil
        )
    }

    private func schedule(_ number: Int, start: String? = nil, due: String? = nil,
                          estimate: Double? = nil, dependsOn: [Int] = [])
        -> LlmIdeAPIClient.IssueSchedule {
        LlmIdeAPIClient.IssueSchedule(
            provider: "github", repo: "acme/app", issueNumber: number,
            startDate: start, dueDate: due, estimateDays: estimate, dependsOn: dependsOn)
    }

    private func day(_ s: String) -> Date {
        AppDateFormatter.parseDateOnly(s) ?? Date.distantPast
    }

    // MARK: - Overlay (GitHub) dates

    func testOverlayStartAndDueDriveTheBar() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7)]
        vm.schedules = [7: schedule(7, start: "2026-03-02", due: "2026-03-10")]

        XCTAssertEqual(vm.startDate(for: vm.issues[0]), day("2026-03-02"))
        XCTAssertEqual(vm.endDate(for: vm.issues[0]), day("2026-03-10"))
    }

    func testOverlayDueOnlyDerivesStartFromEstimate() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7)]
        vm.schedules = [7: schedule(7, due: "2026-03-10", estimate: 3)]

        XCTAssertEqual(vm.startDate(for: vm.issues[0]), day("2026-03-07"))
        XCTAssertEqual(vm.endDate(for: vm.issues[0]), day("2026-03-10"))
    }

    func testOverlayStartOnlyDerivesDueFromEstimate() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7)]
        vm.schedules = [7: schedule(7, start: "2026-03-02", estimate: 4)]

        XCTAssertEqual(vm.endDate(for: vm.issues[0]), day("2026-03-06"))
    }

    /// An overlay row that only records an estimate or a dependency places the
    /// issue nowhere — the native date must still win instead of being masked.
    func testOverlayWithoutDatesFallsBackToNativeDueDate() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7, dueDate: "2026-05-20")]
        vm.schedules = [7: schedule(7, estimate: 2, dependsOn: [3])]

        XCTAssertEqual(vm.endDate(for: vm.issues[0]), day("2026-05-20"))
        XCTAssertEqual(vm.scheduleNote(for: vm.issues[0]), "2d · blocks on #3")
    }

    // MARK: - Native (GitLab) dates

    func testNativeDueDateGetsAWeekLongBarWhenNoOtherAnchor() {
        let vm = GanttViewModel()
        // Created long before the due date, so the 7-day look-back applies.
        vm.issues = [issue(number: 1, createdAt: "2025-11-01T00:00:00Z", dueDate: "2026-03-10")]

        XCTAssertEqual(vm.startDate(for: vm.issues[0]), day("2026-03-03"))
        XCTAssertEqual(vm.endDate(for: vm.issues[0]), day("2026-03-10"))
    }

    /// A bar must never start before the issue existed.
    func testBarNeverStartsBeforeIssueCreation() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 1, createdAt: "2026-03-08T00:00:00Z", dueDate: "2026-03-10")]

        let start = vm.startDate(for: vm.issues[0])
        XCTAssertGreaterThanOrEqual(start, day("2026-03-08"))
        XCTAssertLessThan(start, day("2026-03-10"))
    }

    func testMilestoneDatesFillInForIssuesWithoutTheirOwn() {
        let ms = RepoMilestone(id: "m1", title: "v1", state: "active",
                               dueDate: "2026-04-30", startDate: "2026-04-01",
                               description: nil)
        let vm = GanttViewModel()
        vm.issues = [issue(number: 1, milestone: ms)]

        XCTAssertEqual(vm.startDate(for: vm.issues[0]), day("2026-04-01"))
        XCTAssertEqual(vm.endDate(for: vm.issues[0]), day("2026-04-30"))
    }

    // MARK: - Category + filtering parity

    /// Overdue is computed from the EFFECTIVE due date, so an overdue GitHub
    /// issue (dated only by the overlay) is tinted like an overdue GitLab one.
    func testOverlayDueDateMakesAnIssueOverdue() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7)]
        vm.schedules = [7: schedule(7, due: "2020-01-01")]

        XCTAssertEqual(vm.category(of: vm.issues[0]), "overdue")
    }

    func testClosedBeatsOverdue() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7, state: "closed", dueDate: "2020-01-01")]

        XCTAssertEqual(vm.category(of: vm.issues[0]), "closed")
    }

    func testHideUndatedKeepsOverlayScheduledIssues() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 7), issue(number: 8)]
        vm.schedules = [7: schedule(7, start: "2026-03-02")]
        vm.hideBlankRows = true

        XCTAssertEqual(vm.filteredIssues.map(\.number), [7])
    }

    /// The legend counts categories the legend itself is hiding — otherwise
    /// unchecking "Closed" would zero its own badge.
    func testCountsIgnoreCategoryToggles() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 1), issue(number: 2, state: "closed")]
        vm.visibleCategories = ["open"]

        XCTAssertEqual(vm.filteredIssues.map(\.number), [1])
        XCTAssertEqual(vm.counts.open, 1)
        XCTAssertEqual(vm.counts.closed, 1)
    }

    /// Search matches the per-project issue NUMBER — `iid` on GitLab, `number`
    /// on GitHub — which is what the row label shows on both.
    func testSearchMatchesNumberTitleAndLabels() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 42, labels: ["backend"]),
                     issue(number: 43, labels: ["ui"])]

        vm.searchText = "42"
        XCTAssertEqual(vm.filteredIssues.map(\.number), [42])
        vm.searchText = "ui"
        XCTAssertEqual(vm.filteredIssues.map(\.number), [43])
        vm.searchText = "Issue 43"
        XCTAssertEqual(vm.filteredIssues.map(\.number), [43])
    }

    /// String IDs (GitLab numeric-as-string / GitHub login) filter identically.
    func testAssigneeAndMilestoneFiltersUseStringIds() {
        let bob = RepoUser(id: "bob", username: "bob", displayName: "Bob", avatarUrl: nil)
        let ms = RepoMilestone(id: "3", title: "v2", state: "active",
                               dueDate: nil, startDate: nil, description: nil)
        let vm = GanttViewModel()
        vm.issues = [issue(number: 1, milestone: ms, assignees: [bob]),
                     issue(number: 2)]

        vm.selectedAssigneeIds = ["bob"]
        XCTAssertEqual(vm.filteredIssues.map(\.number), [1])
        vm.selectedAssigneeIds = []
        vm.selectedMilestoneIds = ["3"]
        XCTAssertEqual(vm.filteredIssues.map(\.number), [1])
    }

    func testDependencyEdgesListsVisibleBlockerPairs() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 3), issue(number: 7), issue(number: 9)]
        vm.schedules = [7: schedule(7, start: "2026-03-02", due: "2026-03-10", dependsOn: [3, 99])]

        let edges = vm.dependencyEdges(in: vm.issues)
        XCTAssertEqual(edges, [(3, 7)])
    }

    func testDependencyEdgesRespectsTheVisibleIssueList() {
        let vm = GanttViewModel()
        vm.issues = [issue(number: 3), issue(number: 7)]
        vm.schedules = [7: schedule(7, start: "2026-03-02", dependsOn: [3])]

        let edges = vm.dependencyEdges(in: [vm.issues[1]])
        XCTAssertTrue(edges.isEmpty, "blocker filtered out → no drawable edge")
    }
}
