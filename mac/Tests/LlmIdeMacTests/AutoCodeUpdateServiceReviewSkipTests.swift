import XCTest
@testable import LlmIdeMacLib

final class AutoCodeUpdateServiceReviewSkipTests: XCTestCase {
    private typealias S = AutoCodeUpdateService

    func testSignatureChangesWithHeadAndTemplate() {
        let a = S.reviewSignature(head: "abc", template: "t1")
        XCTAssertEqual(a, S.reviewSignature(head: "abc", template: "t1"))
        XCTAssertNotEqual(a, S.reviewSignature(head: "abd", template: "t1"))
        XCTAssertNotEqual(a, S.reviewSignature(head: "abc", template: "t2"))
        XCTAssertNil(S.reviewSignature(head: nil, template: "t1"))
        XCTAssertNil(S.reviewSignature(head: "", template: "t1"))
    }

    func testSkipsOnlyWhenUnchangedAndNotManual() {
        XCTAssertEqual(S.reviewSkipReason(trigger: .cron, previous: "x", current: "x"),
                       "no changes since last review")
        XCTAssertEqual(S.reviewSkipReason(trigger: .pipeline, previous: "x", current: "x"),
                       "no changes since last review")
        XCTAssertNil(S.reviewSkipReason(trigger: .manual, previous: "x", current: "x"))
        XCTAssertNil(S.reviewSkipReason(trigger: .cron, previous: "x", current: "y"))
        XCTAssertNil(S.reviewSkipReason(trigger: .cron, previous: nil, current: "y"))
        XCTAssertNil(S.reviewSkipReason(trigger: .cron, previous: "x", current: nil))
    }

    func testSignaturePersistsPerTaskAndProject() throws {
        let suite = "reviewskip-\(UUID().uuidString)"
        let d = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { d.removePersistentDomain(forName: suite) }
        XCTAssertNil(S.loadReviewSignature(taskId: "reviewCode", gitRoot: "/p", defaults: d))
        S.saveReviewSignature("sig", taskId: "reviewCode", gitRoot: "/p", defaults: d)
        XCTAssertEqual(S.loadReviewSignature(taskId: "reviewCode", gitRoot: "/p", defaults: d), "sig")
        XCTAssertNil(S.loadReviewSignature(taskId: "reviewDoc", gitRoot: "/p", defaults: d))
        XCTAssertNil(S.loadReviewSignature(taskId: "reviewCode", gitRoot: "/q", defaults: d))
    }
}
