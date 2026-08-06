import XCTest
@testable import LlmIdeMacLib

/// VerifyCommandAuthor.parseReply turns raw LLM output into a shell
/// command that RegressionRunner later executes (gated by
/// VerifyApprovalStore). Getting this parsing wrong means either a
/// real command gets silently dropped (parsed as "no command" when one
/// was actually given), or fence/whitespace noise ends up glued onto
/// the command text that then gets run.
final class VerifyCommandAuthorTests: XCTestCase {
    func testPlainCommandNoFence() {
        XCTAssertEqual(VerifyCommandAuthor.parseReply("npm test"), "npm test")
    }

    func testFencedWithLanguageTag() {
        let raw = "```sh\nnpm test\n```"
        XCTAssertEqual(VerifyCommandAuthor.parseReply(raw), "npm test")
    }

    func testFencedWithoutLanguageTag() {
        let raw = "```\nswift test --filter FooTests\n```"
        XCTAssertEqual(VerifyCommandAuthor.parseReply(raw), "swift test --filter FooTests")
    }

    func testExactNoneReturnsNil() {
        XCTAssertNil(VerifyCommandAuthor.parseReply("NONE"))
    }

    func testNoneIsCaseInsensitive() {
        XCTAssertNil(VerifyCommandAuthor.parseReply("none"))
        XCTAssertNil(VerifyCommandAuthor.parseReply("None"))
    }

    func testEmptyStringReturnsNil() {
        XCTAssertNil(VerifyCommandAuthor.parseReply(""))
    }

    func testFenceWithNoContentReturnsNil() {
        XCTAssertNil(VerifyCommandAuthor.parseReply("```\n```"))
    }

    func testLeadingBlankLinesAreSkipped() {
        let raw = "\n\nnpm test"
        XCTAssertEqual(VerifyCommandAuthor.parseReply(raw), "npm test")
    }

    func testTrailingBlankLinesAfterClosingFenceAreIgnored() {
        let raw = "```\nnpm test\n```\n\n"
        XCTAssertEqual(VerifyCommandAuthor.parseReply(raw), "npm test")
    }

    /// Only the first non-empty content line is used, even if the model
    /// ignored the "SINGLE command" instruction and returned more.
    func testOnlyFirstContentLineIsUsed() {
        let raw = "npm test\nnpm run lint"
        XCTAssertEqual(VerifyCommandAuthor.parseReply(raw), "npm test")
    }

    func testWhitespaceAroundCommandIsTrimmed() {
        XCTAssertEqual(VerifyCommandAuthor.parseReply("   npm test   "), "npm test")
    }

    // MARK: - buildPrompt

    func testBuildPromptIncludesRepoPathAndTruncatedFields() {
        let fault = FaultReport(
            prompt: String(repeating: "p", count: 2_000),
            response: String(repeating: "r", count: 3_000),
            notes: "", severity: .major, reportedAt: Date(), gitHead: nil,
            appVersion: "1.0", agent: "claude", status: .fixed, tags: []
        )
        let repo = URL(fileURLWithPath: "/Users/test/repo")
        let prompt = VerifyCommandAuthor.buildPrompt(fault: fault, repoRoot: repo)

        XCTAssertTrue(prompt.contains("/Users/test/repo"))
        // fault.prompt truncated to 1_000 chars, fault.response to 2_000.
        XCTAssertTrue(prompt.contains(String(repeating: "p", count: 1_000)))
        XCTAssertFalse(prompt.contains(String(repeating: "p", count: 1_001)))
        XCTAssertTrue(prompt.contains(String(repeating: "r", count: 2_000)))
        XCTAssertFalse(prompt.contains(String(repeating: "r", count: 2_001)))
    }
}
