import XCTest
@testable import LlmIdeMacLib

final class QuickChatContextTests: XCTestCase {
    func testNoProjectMessageNamesTheReason() {
        // The phone shows this verbatim, so it must explain WHY rather than
        // just refuse.
        XCTAssertTrue(QuickChatContext.noProjectMessage.contains("Open a project"))
        XCTAssertTrue(QuickChatContext.noProjectMessage.contains("memory"))
    }
}
