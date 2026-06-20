import Testing
@testable import LlmIdeMac

struct VerifyCommandAuthorTests {
    @Test func noneReplyYieldsNilCommand() {
        #expect(VerifyCommandAuthor.parseReply("NONE") == nil)
        #expect(VerifyCommandAuthor.parseReply("  none ") == nil)
    }
    @Test func commandReplyIsTrimmed() {
        #expect(VerifyCommandAuthor.parseReply("```\nswift test --filter X\n```") == "swift test --filter X")
        #expect(VerifyCommandAuthor.parseReply("swift test --filter X\n") == "swift test --filter X")
    }
    @Test func emptyReplyYieldsNil() {
        #expect(VerifyCommandAuthor.parseReply("") == nil)
    }
    @Test func languageTaggedFenceYieldsCommandNotLang() {
        #expect(VerifyCommandAuthor.parseReply("```sh\nmake test\n```") == "make test")
        #expect(VerifyCommandAuthor.parseReply("```bash\npytest -k auth\n```") == "pytest -k auth")
    }
}
