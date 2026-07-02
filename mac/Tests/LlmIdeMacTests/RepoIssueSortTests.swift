import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct RepoIssueSortTests {
    func issue(_ n: Int, title: String = "T", createdAt: String = "2026-07-01T00:00:00Z",
               updatedAt: String = "2026-07-01T00:00:00Z", milestoneDue: String? = nil,
               weight: Int? = nil) -> RepoIssue {
        let ms: RepoMilestone? = milestoneDue.map {
            RepoMilestone(id: "m", title: "M", state: "active", dueDate: $0, startDate: nil, description: nil)
        }
        return RepoIssue(id: "i\(n)", number: n, title: title, body: nil, state: "opened",
                         labels: [], milestone: ms, assignees: [], author: .ghost,
                         createdAt: createdAt, updatedAt: updatedAt, closedAt: nil, webUrl: "",
                         commentCount: 0, dueDate: nil, weight: weight)
    }

    @Test func createdDescendingIsNewestFirst() {
        let a = issue(1, createdAt: "2026-07-01T00:00:00Z")
        let b = issue(2, createdAt: "2026-07-03T00:00:00Z")
        let c = issue(3, createdAt: "2026-07-02T00:00:00Z")
        let out = RepoIssueSort.sorted([a, b, c], by: .created, ascending: false)
        #expect(out.map(\.number) == [2, 3, 1])
    }

    @Test func createdAscendingIsOldestFirst() {
        let a = issue(1, createdAt: "2026-07-01T00:00:00Z")
        let b = issue(2, createdAt: "2026-07-03T00:00:00Z")
        let out = RepoIssueSort.sorted([a, b], by: .created, ascending: true)
        #expect(out.map(\.number) == [1, 2])
    }

    @Test func titleIsCaseInsensitive() {
        let a = issue(1, title: "Banana")
        let b = issue(2, title: "apple")
        let out = RepoIssueSort.sorted([a, b], by: .title, ascending: true)
        #expect(out.map(\.number) == [2, 1])   // apple < Banana, case-insensitive
    }

    @Test func nilWeightAlwaysSortsLast() {
        let a = issue(1, weight: 5)
        let b = issue(2, weight: nil)
        let c = issue(3, weight: 2)
        #expect(RepoIssueSort.sorted([a, b, c], by: .weight, ascending: true).map(\.number) == [3, 1, 2])
        // Even descending, the nil-weight issue stays at the bottom (not treated as ∞).
        #expect(RepoIssueSort.sorted([a, b, c], by: .weight, ascending: false).map(\.number) == [1, 3, 2])
    }

    @Test func nilMilestoneDueSortsLast() {
        let a = issue(1, milestoneDue: "2026-08-01")
        let b = issue(2, milestoneDue: nil)
        let c = issue(3, milestoneDue: "2026-07-15")
        #expect(RepoIssueSort.sorted([a, b, c], by: .milestone, ascending: true).map(\.number) == [3, 1, 2])
    }
}
