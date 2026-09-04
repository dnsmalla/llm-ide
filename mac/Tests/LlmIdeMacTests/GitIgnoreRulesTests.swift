import XCTest
@testable import LlmIdeMacLib

/// `.gitignore` is hand-translated to regex here (Foundation has no glob
/// engine and `git check-ignore` is one subprocess per path — and fails
/// outright outside a repo). A subtle anchoring or precedence bug silently
/// changes which files a search reads, with no compiler help to catch it.
final class GitIgnoreRulesTests: XCTestCase {

    private func rules(_ text: String, base: String = "") -> GitIgnoreRules {
        var out = GitIgnoreRules()
        out.add(text: text, base: base)
        return out
    }

    func testEmptyRulesIgnoreNothing() {
        let r = GitIgnoreRules()
        XCTAssertTrue(r.isEmpty)
        XCTAssertFalse(r.isIgnored(relativePath: "a/b.txt", isDirectory: false))
    }

    func testCommentsAndBlankLinesAreSkipped() {
        let r = rules("# a comment\n\n   \n*.log\n")
        XCTAssertEqual(r.rules.count, 1)
        XCTAssertTrue(r.isIgnored(relativePath: "x.log", isDirectory: false))
    }

    func testBareNameIgnoresAtAnyDepth() {
        let r = rules("node_modules\n")
        XCTAssertTrue(r.isIgnored(relativePath: "node_modules/x.js", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "a/b/node_modules/x.js", isDirectory: false))
    }

    func testLeadingSlashAnchorsToTheGitignoreDirectory() {
        let r = rules("/build\n")
        XCTAssertTrue(r.isIgnored(relativePath: "build/out.o", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "src/build/out.o", isDirectory: false))
    }

    func testEmbeddedSlashAlsoAnchors() {
        let r = rules("src/generated\n")
        XCTAssertTrue(r.isIgnored(relativePath: "src/generated/a.swift", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "app/src/generated/a.swift", isDirectory: false))
    }

    func testTrailingSlashMatchesDirectoriesOnly() {
        let r = rules("logs/\n")
        XCTAssertTrue(r.isIgnored(relativePath: "logs", isDirectory: true))
        XCTAssertFalse(r.isIgnored(relativePath: "logs", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "logs/today.txt", isDirectory: false))
    }

    func testNegationReIncludesAFile() {
        let r = rules("*.log\n!keep.log\n")
        XCTAssertTrue(r.isIgnored(relativePath: "drop.log", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "keep.log", isDirectory: false))
    }

    func testNegationCannotEscapeAnIgnoredParentDirectory() {
        // git: "It is not possible to re-include a file if a parent
        // directory of that file is excluded."
        let r = rules("build/\n!build/keep.txt\n")
        XCTAssertTrue(r.isIgnored(relativePath: "build/keep.txt", isDirectory: false))
    }

    func testSingleStarDoesNotCrossASlash() {
        let r = rules("src/*.swift\n")
        XCTAssertTrue(r.isIgnored(relativePath: "src/a.swift", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "src/deep/a.swift", isDirectory: false))
    }

    func testDoubleStarCrossesDirectories() {
        let r = rules("docs/**/*.md\n")
        XCTAssertTrue(r.isIgnored(relativePath: "docs/a.md", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "docs/x/y/a.md", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "notes/a.md", isDirectory: false))
    }

    func testQuestionMarkMatchesOneCharacter() {
        let r = rules("tmp?.txt\n")
        XCTAssertTrue(r.isIgnored(relativePath: "tmp1.txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "tmp12.txt", isDirectory: false))
    }

    func testCharacterClassDegradesToALiteralMatch() {
        // Ruling: `[...]` and `\` are out of scope. Degrade to literal rather
        // than emit a regex that means something else.
        let r = rules("file[1].txt\n")
        XCTAssertTrue(r.isIgnored(relativePath: "file[1].txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "file1.txt", isDirectory: false))
    }

    func testTrailingWhitespaceIsTrimmed() {
        let r = rules("*.tmp   \n")
        XCTAssertTrue(r.isIgnored(relativePath: "a.tmp", isDirectory: false))
    }

    func testNestedGitignoreOnlyAppliesToItsOwnSubtree() {
        var r = GitIgnoreRules()
        r.add(text: "*.tmp\n", base: "sub")
        XCTAssertTrue(r.isIgnored(relativePath: "sub/a.tmp", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "sub/deep/a.tmp", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "a.tmp", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "other/a.tmp", isDirectory: false))
    }

    func testLaterRuleWinsAtTheSameLevel() {
        var r = GitIgnoreRules()
        r.add(text: "*.txt\n", base: "")
        r.add(text: "!notes.txt\n", base: "sub")
        XCTAssertTrue(r.isIgnored(relativePath: "notes.txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "sub/notes.txt", isDirectory: false))
    }

    func testRepoRootReadsGitignoreAndInfoExclude() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gitignore-rules-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(".git/info"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try "*.log\n".write(to: root.appendingPathComponent(".gitignore"),
                            atomically: true, encoding: .utf8)
        try "secret.txt\n".write(to: root.appendingPathComponent(".git/info/exclude"),
                                 atomically: true, encoding: .utf8)

        let r = GitIgnoreRules.repoRoot(root)
        XCTAssertTrue(r.isIgnored(relativePath: "a.log", isDirectory: false))
        XCTAssertTrue(r.isIgnored(relativePath: "secret.txt", isDirectory: false))
        XCTAssertFalse(r.isIgnored(relativePath: "a.swift", isDirectory: false))
    }

    func testRepoRootOnANonRepoFolderIsEmpty() {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("gitignore-none-\(UUID().uuidString)")
        XCTAssertTrue(GitIgnoreRules.repoRoot(root).isEmpty)
    }
}
