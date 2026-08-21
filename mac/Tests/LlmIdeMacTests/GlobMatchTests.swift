import XCTest
@testable import LlmIdeMacLib

/// GlobMatch translates glob patterns to regex by hand (no Foundation glob
/// API) — a subtle escaping or `**` bug here silently changes which files
/// match a search/filter pattern without any compiler help to catch it.
final class GlobMatchTests: XCTestCase {

    // MARK: - Bare prefix (no glob metachars)

    func testEmptyPatternMatchesEverything() {
        XCTAssertTrue(GlobMatch.matches(path: "any/file.txt", pattern: ""))
    }

    func testBareDirExactMatch() {
        XCTAssertTrue(GlobMatch.matches(path: "app/job/logic", pattern: "app/job/logic"))
    }

    func testBareDirPrefixMatchesFilesUnderIt() {
        XCTAssertTrue(GlobMatch.matches(path: "app/job/logic/file.txt", pattern: "app/job/logic"))
    }

    func testBareDirPatternWithTrailingSlashMatchesFilesUnderIt() {
        XCTAssertTrue(GlobMatch.matches(path: "app/job/logic/file.txt", pattern: "app/job/logic/"))
    }

    func testBareDirDoesNotMatchUnrelatedPath() {
        XCTAssertFalse(GlobMatch.matches(path: "app/other/file.txt", pattern: "app/job/logic"))
    }

    /// Regression guard: "app/job" must not match "app/job2/..." — a naive
    /// `path.hasPrefix(pattern)` (without appending "/") would wrongly treat
    /// "job2" as living under "job".
    func testBareDirDoesNotMatchSiblingWithSharedPrefix() {
        XCTAssertFalse(GlobMatch.matches(path: "app/job2/file.txt", pattern: "app/job"))
    }

    // MARK: - `*` within a segment

    func testStarMatchesWithinSegment() {
        XCTAssertTrue(GlobMatch.matches(path: "file.swift", pattern: "*.swift"))
    }

    func testStarDoesNotCrossSegmentBoundary() {
        XCTAssertFalse(GlobMatch.matches(path: "dir/file.swift", pattern: "*.swift"))
    }

    /// The literal "." in the pattern must be regex-escaped, not treated
    /// as "any character" — otherwise "*.txt" would also match "filextxt".
    func testDotInPatternIsEscapedNotWildcard() {
        XCTAssertTrue(GlobMatch.matches(path: "anything.txt", pattern: "*.txt"))
        XCTAssertFalse(GlobMatch.matches(path: "anythingxtxt", pattern: "*.txt"))
    }

    // MARK: - `**`

    func testBareDoubleStarMatchesAnyPath() {
        XCTAssertTrue(GlobMatch.matches(path: "a/b/c.txt", pattern: "**"))
        XCTAssertTrue(GlobMatch.matches(path: "c.txt", pattern: "**"))
    }

    func testDoubleStarSlashMatchesNestedFile() {
        XCTAssertTrue(GlobMatch.matches(path: "src/lib/c.swift", pattern: "**/*.swift"))
    }

    /// `**/` is optional so the pattern also matches root-level files —
    /// documented explicitly in GlobMatch's doc comment.
    func testDoubleStarSlashAlsoMatchesRootLevelFile() {
        XCTAssertTrue(GlobMatch.matches(path: "c.swift", pattern: "**/*.swift"))
    }

    /// The exact pattern shape the Loop Engine's scope allowlist uses
    /// (`"src/auth/**"`): `**` must extend into subdirectories (so a deeper
    /// file under the scoped dir is still in scope) but must NOT match a
    /// sibling directory that merely shares the prefix ("authentication" is
    /// not "auth") — a glob loose enough to blur that boundary would let
    /// out-of-scope edits slip past unnoticed.
    func testDoubleStarSuffixMatchesNestedPathButNotPrefixSharingSibling() {
        XCTAssertTrue(GlobMatch.matches(path: "src/auth/sub/Deep.swift", pattern: "src/auth/**"))
        XCTAssertFalse(GlobMatch.matches(path: "src/authentication/Other.swift", pattern: "src/auth/**"))
    }

    // MARK: - `?`

    func testQuestionMarkMatchesExactlyOneNonSlashChar() {
        XCTAssertTrue(GlobMatch.matches(path: "file1.txt", pattern: "file?.txt"))
        XCTAssertFalse(GlobMatch.matches(path: "file.txt", pattern: "file?.txt"))
        XCTAssertFalse(GlobMatch.matches(path: "file12.txt", pattern: "file?.txt"))
    }

    // MARK: - Bracket characters (escaped as literals, not a char class)

    /// `[`/`]` are regex-escaped like any other special char — GlobMatch's
    /// doc comment doesn't claim char-class support, so a literal bracket
    /// in the pattern requires a literal bracket in the path.
    func testBracketsAreTreatedAsLiteralCharacters() {
        XCTAssertTrue(GlobMatch.matches(path: "file[1].txt", pattern: "file[1].txt"))
        XCTAssertFalse(GlobMatch.matches(path: "file1.txt", pattern: "file[1].txt"))
    }

    // MARK: - matchesAny

    func testMatchesAnyEmptyListMatchesEverything() {
        XCTAssertTrue(GlobMatch.matchesAny(path: "any/file.txt", patterns: ""))
    }

    func testMatchesAnyMatchesWhenOnePatternHits() {
        XCTAssertTrue(GlobMatch.matchesAny(path: "src/file.swift", patterns: "*.md, **/*.swift"))
    }

    func testMatchesAnyFalseWhenNonePatternHits() {
        XCTAssertFalse(GlobMatch.matchesAny(path: "src/file.swift", patterns: "*.md, *.txt"))
    }

    func testMatchesAnyTrimsWhitespaceAroundPatterns() {
        XCTAssertTrue(GlobMatch.matchesAny(path: "file.md", patterns: "  *.md  ,  *.txt "))
    }
}
