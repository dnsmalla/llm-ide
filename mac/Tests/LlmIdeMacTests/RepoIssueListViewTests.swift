import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct RepoIssueListViewTests {
    func issue(
        number: Int = 1, title: String = "T", state: String = "opened",
        labels: [String] = [], milestone: RepoMilestone? = nil,
        assignees: [RepoUser] = [], commentCount: Int = 0,
        createdAt: String = "2026-07-01T00:00:00Z", weight: Int? = nil
    ) -> RepoIssue {
        RepoIssue(id: "i\(number)", number: number, title: title, body: nil,
                  state: state, labels: labels, milestone: milestone,
                  assignees: assignees, author: .ghost, createdAt: createdAt,
                  updatedAt: createdAt, closedAt: nil, webUrl: "", commentCount: commentCount,
                  dueDate: nil, weight: weight)
    }
    let u1 = RepoUser(id: "1", username: "a", displayName: "Alice", avatarUrl: nil)
    let u2 = RepoUser(id: "2", username: "b", displayName: "Bob", avatarUrl: nil)

    @Test func metaLineShowsNumberAndRelativeAgeAndMilestone() {
        let ms = RepoMilestone(id: "m1", title: "v1.2", state: "active", dueDate: nil, startDate: nil, description: nil)
        let now = ISO8601DateFormatter().date(from: "2026-07-04T00:00:00Z")!
        let line = RepoIssueListView.metaLine(for: issue(number: 7, milestone: ms), now: now)
        #expect(line.contains("#7"))
        #expect(line.contains("3d"))          // opened 3 days before `now`
        #expect(line.contains("v1.2"))        // milestone name included
    }

    @Test func metaLineOmitsMilestoneWhenAbsent() {
        let now = ISO8601DateFormatter().date(from: "2026-07-02T00:00:00Z")!
        let line = RepoIssueListView.metaLine(for: issue(number: 9, milestone: nil), now: now)
        #expect(line.contains("#9"))
        #expect(!line.contains("·  ·"))       // no empty milestone segment
    }

    @Test func assigneeOverflowShowsFirstAndCountsExtra() {
        let none = RepoIssueListView.assigneeOverflow([])
        #expect(none.shown == nil && none.extra == 0)
        let one = RepoIssueListView.assigneeOverflow([u1])
        #expect(one.shown?.id == "1" && one.extra == 0)
        let many = RepoIssueListView.assigneeOverflow([u1, u2])
        #expect(many.shown?.id == "1" && many.extra == 1)
    }
}
