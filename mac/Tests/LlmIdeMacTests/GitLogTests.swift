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

@Suite struct StashTests {
    @Test func parsesStashList() {
        let out = """
        stash@{0}: WIP on main: 1a2b3c4 Fix bug
        stash@{1}: On feature/x: my custom message
        stash@{2}: WIP on main: 5d6e7f8 Add feature
        """
        let stashes = SourceControlService.parseStashList(out)
        #expect(stashes.count == 3)
        #expect(stashes[0].index == 0)
        #expect(stashes[0].message == "WIP on main: 1a2b3c4 Fix bug")
        #expect(stashes[1].index == 1)
        #expect(stashes[1].message == "On feature/x: my custom message")
        #expect(stashes[2].index == 2)
        #expect(stashes[2].message == "WIP on main: 5d6e7f8 Add feature")
    }

    @Test func skipsMalformedLines() {
        let out = "not a stash line\nstash@{0}: WIP on main: deadbee Edit\n"
        let stashes = SourceControlService.parseStashList(out)
        #expect(stashes.count == 1)
        #expect(stashes[0].index == 0)
        #expect(stashes[0].message == "WIP on main: deadbee Edit")
    }
}
