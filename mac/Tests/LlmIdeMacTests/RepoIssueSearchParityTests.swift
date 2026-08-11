import XCTest
@testable import LlmIdeMacLib

/// The issue board is one view for both providers, but only GitLab's issues
/// endpoint takes a `search` parameter. GitHub's does not (text search lives on
/// /search/issues, with a far lower rate limit), so the board pages first and
/// narrows locally — signalled by `filtersSearchServerSide`.
///
/// Two regressions are pinned here:
///   • The search box used to be dropped entirely on GitHub: typing narrowed
///     the GitLab board and did nothing at all on GitHub.
///   • Filtering inside the paged `listIssues` call instead would end
///     pagination at the first page containing no match, silently truncating
///     results on a large repo.
@MainActor
final class RepoIssueSearchParityTests: XCTestCase {

    private func issue(_ number: Int, title: String, body: String? = nil) -> RepoIssue {
        RepoIssue(
            id: "i\(number)", number: number, title: title, body: body,
            state: "opened", labels: [], milestone: nil, assignees: [],
            author: RepoUser(id: "u1", username: "alice", displayName: "Alice", avatarUrl: nil),
            createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
            closedAt: nil, webUrl: "https://example.test/i/\(number)",
            commentCount: 0, dueDate: nil, weight: nil
        )
    }

    func testEmptySearchMatchesEverything() {
        let filter = RepoIssueFilter(state: .all, search: "")
        XCTAssertTrue(filter.matchesLocally(issue(1, title: "Anything")))
        XCTAssertTrue(RepoIssueFilter(state: .all, search: "   ")
            .matchesLocally(issue(1, title: "Anything")))
    }

    func testSearchMatchesTitleCaseInsensitively() {
        let filter = RepoIssueFilter(state: .all, search: "CAPTION")
        XCTAssertTrue(filter.matchesLocally(issue(1, title: "Fix caption scraper")))
        XCTAssertFalse(filter.matchesLocally(issue(2, title: "Unrelated work")))
    }

    /// GitLab's server-side `search` covers title AND description, so the local
    /// fallback has to as well — otherwise the same query returns fewer results
    /// on GitHub than on GitLab.
    func testSearchMatchesBody() {
        let filter = RepoIssueFilter(state: .all, search: "regression")
        XCTAssertTrue(filter.matchesLocally(
            issue(1, title: "Timeline bug", body: "Caused a regression in the gantt")))
    }

    func testSearchMatchesIssueNumber() {
        let filter = RepoIssueFilter(state: .all, search: "#42")
        XCTAssertTrue(filter.matchesLocally(issue(42, title: "Anything")))
        XCTAssertFalse(filter.matchesLocally(issue(43, title: "Anything")))
    }

    func testNilBodyDoesNotMatchEverything() {
        let filter = RepoIssueFilter(state: .all, search: "missing")
        XCTAssertFalse(filter.matchesLocally(issue(1, title: "Title only", body: nil)))
    }

    /// The flag is what tells the board whether to narrow locally. GitHub must
    /// stay false — flipping it back on would silently disable the search box.
    func testOnlyGitLabFiltersSearchServerSide() {
        let defaults = UserDefaults(suiteName: "RepoIssueSearchParityTests-\(UUID().uuidString)")!
        let config = AppConfig(userDefaults: defaults)
        XCTAssertTrue(GitLabClient(config: config).filtersSearchServerSide)
        XCTAssertFalse(GitHubClient(config: config).filtersSearchServerSide)
    }
}
