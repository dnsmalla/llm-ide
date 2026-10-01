import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

final class PhoneIssuesTests: XCTestCase {
    private func user(_ n: String) -> RepoUser { RepoUser(id: n, username: n, displayName: n, avatarUrl: "https://avatar/\(n)") }
    private func issue(_ n: Int, updated: String = "2026-10-01T00:00:00Z", body: String? = "body",
                       url: String = "https://github.com/o/r/issues/1") -> RepoIssue {
        RepoIssue(id: "\(n)", number: n, title: "Issue \(n)", body: body, state: "opened", labels: ["bug"],
                  milestone: nil, assignees: [user("bob")], author: user("amy"), createdAt: "2026-09-01T00:00:00Z",
                  updatedAt: updated, closedAt: nil, webUrl: url, commentCount: 2, dueDate: nil, weight: nil)
    }
    private func note(_ id: String, _ body: String, system: Bool = false) -> RepoNote {
        RepoNote(id: id, body: body, author: user("amy"), createdAt: "2026-09-02T00:00:00Z", isSystem: system)
    }

    func testListIsNewestFirstAndCapped() {
        let issues = (1...80).map { issue($0, updated: String(format: "2026-10-01T00:%02d:00Z", $0 % 60)) }
        let s = PhoneIssues.summaries(issues)
        XCTAssertEqual(s.count, PhoneIssues.maxIssues)
        XCTAssertEqual(s.first?.assignee, "bob")
    }

    func testDetailCapsCommentsKeepsTheNewestAndNeverCarriesAvatars() throws {
        let notes = (1...45).map { note("n\($0)", "comment \($0)", system: $0 % 5 == 0) }   // 36 real, 9 system
        let d = PhoneIssues.detail(issue(7), notes: notes, canComment: true)
        XCTAssertEqual(d.comments.count, PhoneIssues.maxComments)
        XCTAssertEqual(d.comments.last?.id, "n44", "the newest real comment is kept (n45 is a system note)")
        XCTAssertFalse(d.comments.contains { $0.id == "n5" || $0.id == "n10" }, "system notes are dropped")
        XCTAssertFalse(d.comments.contains { $0.id == "n1" }, "the oldest are the ones cut")
        let json = String(data: try JSONEncoder().encode(d), encoding: .utf8)!
        XCTAssertFalse(json.contains("avatar"))
    }

    func testSystemNotesAreFilteredOut() {
        let d = PhoneIssues.detail(issue(1), notes: [note("a", "real"), note("b", "closed the issue", system: true)],
                                   canComment: false)
        XCTAssertEqual(d.comments.map(\.id), ["a"])
    }

    func testBodyAndCommentsAreRedactedAndBounded() {
        let secret = "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"
        let huge = String(repeating: "y", count: 150_000)
        let started = Date()
        let d = PhoneIssues.detail(issue(1, body: secret + "\n" + huge), notes: [note("c", secret)], canComment: false)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertFalse(d.body?.contains("ghp_abcdefghijklmnopqrstuvwxyz") == true)
        XCTAssertFalse(d.comments.first?.body.contains("ghp_abcdefghijklmnopqrstuvwxyz") == true)
        XCTAssertLessThanOrEqual(d.body?.count ?? 0, PhoneIssues.maxBody)
    }

    func testOnlyWebLinksAreOffered() {
        XCTAssertNotNil(PhoneIssues.safeURL("https://gitlab.com/a/b/-/issues/3"))
        XCTAssertNil(PhoneIssues.safeURL("javascript:alert(1)"))
        XCTAssertNil(PhoneIssues.safeURL("file:///etc/passwd"))
        XCTAssertNil(PhoneIssues.detail(issue(1, url: "tel:123"), notes: [], canComment: false).webUrl)
    }

    func testCommentRefusals() {
        XCTAssertEqual(PhoneIssues.commentRefusal(switchOn: false, body: "hi"), PhoneAccess.issueComment.deniedMessage)
        XCTAssertNotNil(PhoneIssues.commentRefusal(switchOn: true, body: "   \n"))
        XCTAssertNotNil(PhoneIssues.commentRefusal(switchOn: true, body: String(repeating: "a", count: 5_000)))
        XCTAssertNil(PhoneIssues.commentRefusal(switchOn: true, body: "Looks good"))
    }
}
