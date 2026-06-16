import Testing
import Foundation
@testable import LlmIdeMac

@Suite struct GlobMatchTests {
    @Test func bareDirPrefixMatches() {
        #expect(GlobMatch.matches(path: "app/job/x.py", pattern: "app/job/"))
        #expect(GlobMatch.matches(path: "app/job/a/b.py", pattern: "app/job/"))
        #expect(GlobMatch.matches(path: "app/job", pattern: "app/job"))
        #expect(!GlobMatch.matches(path: "app/other.py", pattern: "app/job/"))
        #expect(!GlobMatch.matches(path: "app/jobless.py", pattern: "app/job"))
    }

    @Test func starMatchesWithinSegment() {
        #expect(GlobMatch.matches(path: "x.py", pattern: "*.py"))
        #expect(!GlobMatch.matches(path: "x.txt", pattern: "*.py"))
        // `*` does not cross a `/`
        #expect(!GlobMatch.matches(path: "a/x.py", pattern: "*.py"))
    }

    @Test func doubleStarCrossesSlashes() {
        #expect(GlobMatch.matches(path: "a/b/c.swift", pattern: "**/*.swift"))
        #expect(GlobMatch.matches(path: "c.swift", pattern: "**/*.swift"))
        #expect(!GlobMatch.matches(path: "a/b/c.py", pattern: "**/*.swift"))
    }

    @Test func emptyPatternMatchesAll() {
        #expect(GlobMatch.matches(path: "anything/here.py", pattern: ""))
        #expect(GlobMatch.matches(path: "anything/here.py", pattern: "   "))
    }

    @Test func matchesAnyEmptyListMatchesAll() {
        #expect(GlobMatch.matchesAny(path: "a/b.py", patterns: ""))
        #expect(GlobMatch.matchesAny(path: "a/b.py", patterns: "  ,  "))
    }

    @Test func matchesAnyCommaSeparated() {
        #expect(GlobMatch.matchesAny(path: "a/b.py", patterns: "*.swift, **/*.py"))
        #expect(!GlobMatch.matchesAny(path: "a/b.txt", patterns: "*.swift, **/*.py"))
    }
}
