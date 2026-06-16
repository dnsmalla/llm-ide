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

@Suite struct BlameTests {
    @Test func parsesPorcelainBlame() {
        // Two-line porcelain fixture: line 1 from one commit, line 2 from
        // another. Each group: <sha> <orig> <final> [count], headers, then
        // a tab-prefixed content line.
        let out = """
        299077d5a14174349468216f775b7e24fe340859 1 1 2
        author Jane Doe
        author-mail <jane@x.co>
        author-time 1781532895
        summary initial
        filename f.txt
        \tline one
        37bf0cfa520197cf1a36ebc435ddb6a3b9570ee2 2 2 1
        author Bob Smith
        author-mail <bob@x.co>
        author-time 1781532999
        summary second
        previous 299077d5a14174349468216f775b7e24fe340859 f.txt
        filename f.txt
        \tline two
        """
        let lines = GitLog.parseBlame(out)
        #expect(lines.count == 2)
        #expect(lines[0].line == 1)
        #expect(lines[0].shortSha == "299077d")
        #expect(lines[0].author == "Jane Doe")
        #expect(lines[1].line == 2)
        #expect(lines[1].shortSha == "37bf0cf")
        #expect(lines[1].author == "Bob Smith")
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
