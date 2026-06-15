import Testing
@testable import LlmIdeMac

@Suite struct GitLogTests {
    @Test func parsesLogLines() {
        // fields delimited by US (0x1f), records by newline
        let us = "\u{1f}"
        let out = "abc123\(us)abc\(us)Jane\(us)2 days ago\(us)Fix bug\ndef456\(us)def\(us)Bob\(us)1 week ago\(us)Add feature"
        let commits = GitLog.parse(out)
        #expect(commits.count == 2)
        #expect(commits[0].sha == "abc123")          // full sha drives commitDiff/identity
        #expect(commits[0].shortSha == "abc")
        #expect(commits[0].author == "Jane")
        #expect(commits[0].relativeDate == "2 days ago")
        #expect(commits[0].subject == "Fix bug")
        #expect(commits[1].sha == "def456")
        #expect(commits[1].subject == "Add feature")
    }
}
