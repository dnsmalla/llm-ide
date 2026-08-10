import XCTest
@testable import LlmIdeMacLib

/// StatusParser/UnifiedDiffParser feed GitStatusStore, GitGutter, and
/// SourceControlService — a parsing regression here corrupts the
/// Source Control panel's file list or the inline diff view app-wide.
final class SCMParsersTests: XCTestCase {

    // MARK: - StatusParser

    func testUnstagedModified() {
        let changes = StatusParser.parse(porcelain: " M path.txt")
        XCTAssertEqual(changes, [FileChange(path: "path.txt", status: .modified, staged: false)])
    }

    func testStagedModified() {
        let changes = StatusParser.parse(porcelain: "M  path.txt")
        XCTAssertEqual(changes, [FileChange(path: "path.txt", status: .modified, staged: true)])
    }

    func testStagedAndUnstagedProducesTwoEntries() {
        let changes = StatusParser.parse(porcelain: "MM path.txt")
        XCTAssertEqual(changes, [
            FileChange(path: "path.txt", status: .modified, staged: true),
            FileChange(path: "path.txt", status: .modified, staged: false),
        ])
    }

    func testStagedAdded() {
        let changes = StatusParser.parse(porcelain: "A  new.txt")
        XCTAssertEqual(changes, [FileChange(path: "new.txt", status: .added, staged: true)])
    }

    func testUnstagedDeleted() {
        let changes = StatusParser.parse(porcelain: " D gone.txt")
        XCTAssertEqual(changes, [FileChange(path: "gone.txt", status: .deleted, staged: false)])
    }

    func testUntrackedFile() {
        let changes = StatusParser.parse(porcelain: "?? new.txt")
        XCTAssertEqual(changes, [FileChange(path: "new.txt", status: .untracked, staged: false)])
    }

    func testConflictedFile() {
        let changes = StatusParser.parse(porcelain: "UU conflict.txt")
        XCTAssertEqual(changes, [FileChange(path: "conflict.txt", status: .conflicted, staged: false)])
    }

    func testTypeChangeMapsToModified() {
        let changes = StatusParser.parse(porcelain: "T  link.txt")
        XCTAssertEqual(changes, [FileChange(path: "link.txt", status: .modified, staged: true)])
    }

    func testRenameKeepsNewPath() {
        let changes = StatusParser.parse(porcelain: "R  old.txt -> new.txt")
        XCTAssertEqual(changes, [FileChange(path: "new.txt", status: .renamed, staged: true)])
    }

    func testQuotedPathIsUnquoted() {
        let changes = StatusParser.parse(porcelain: "M  \"path with spaces.txt\"")
        XCTAssertEqual(changes, [FileChange(path: "path with spaces.txt", status: .modified, staged: true)])
    }

    func testTooShortLineIsSkipped() {
        XCTAssertEqual(StatusParser.parse(porcelain: "M"), [])
        XCTAssertEqual(StatusParser.parse(porcelain: ""), [])
    }

    func testMultipleLinesCombined() {
        let porcelain = "M  staged.txt\n?? new.txt\n D gone.txt"
        let changes = StatusParser.parse(porcelain: porcelain)
        XCTAssertEqual(changes, [
            FileChange(path: "staged.txt", status: .modified, staged: true),
            FileChange(path: "new.txt", status: .untracked, staged: false),
            FileChange(path: "gone.txt", status: .deleted, staged: false),
        ])
    }

    // MARK: - UnifiedDiffParser

    func testNoHunksReturnsEmpty() {
        XCTAssertEqual(UnifiedDiffParser.parse("diff --git a/x b/x\nindex abc..def 100644\n"), [])
    }

    func testSingleHunkLineNumbersAndKinds() {
        let diff = """
        diff --git a/file.txt b/file.txt
        index abc123..def456 100644
        --- a/file.txt
        +++ b/file.txt
        @@ -1,3 +1,4 @@
         line1
        -line2
        +line2 modified
        +line2b
         line3
        """
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].header, "@@ -1,3 +1,4 @@")
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "line1"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "line2"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 2, text: "line2 modified"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 3, text: "line2b"),
            DiffRow(kind: .context, oldLine: 3, newLine: 4, text: "line3"),
        ])
    }

    func testHunkHeaderWithTrailingFunctionContextIsNotConfused() {
        // The trailing "func add() -> Int {" contains '-' and '+'-like tokens
        // that must NOT be mistaken for the range fields.
        let (old, new) = privateHunkStarts("@@ -10,5 +10,6 @@ func add() -> Int {")
        XCTAssertEqual(old, 10)
        XCTAssertEqual(new, 10)
    }

    /// Every real `git diff` ends with a newline. Splitting on "\n" with empty
    /// subsequences kept then yields a trailing "" component, which the parser's
    /// blank-line branch turned into a phantom empty context row under the last
    /// hunk of every diff the app rendered. The existing blank-line test only
    /// caught it because it was the one case with a trailing newline; the literals
    /// elsewhere in this file happen not to have one.
    func testTrailingNewlineDoesNotProduceAPhantomRow() {
        let hunks = UnifiedDiffParser.parse("@@ -1,1 +1,1 @@\n-old\n+new\n")
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .delete, oldLine: 1, newLine: nil, text: "old"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 1, text: "new"),
        ])
    }

    /// The same diff with and without its terminator must parse identically —
    /// which is what stops the fix from being re-broken by "just omit empty
    /// subsequences" (that would also drop real blank context lines).
    func testTrailingNewlineIsIrrelevantToTheResult() {
        let withTerminator = UnifiedDiffParser.parse("@@ -1,2 +1,2 @@\n line1\n line2\n")
        let without = UnifiedDiffParser.parse("@@ -1,2 +1,2 @@\n line1\n line2")
        XCTAssertEqual(withTerminator, without)
    }

    /// CRLF diffs (a checkout with CRLF line endings) must not leave a stray \r
    /// as a one-character "context" row either.
    func testCRLFTerminatorIsAlsoDropped() {
        let hunks = UnifiedDiffParser.parse("@@ -1,1 +1,1 @@\n+new\r\n")
        XCTAssertEqual(hunks[0].rows.count, 1)
    }

    func testBlankLineWithinHunkIsEmptyContextRow() {
        let diff = "@@ -1,2 +1,2 @@\n line1\n\n"
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "line1"),
            DiffRow(kind: .context, oldLine: 2, newLine: 2, text: ""),
        ])
    }

    func testMultipleHunksProduceSeparateEntries() {
        let diff = """
        @@ -1,1 +1,1 @@
        -old
        +new
        @@ -10,1 +10,1 @@
        -old2
        +new2
        """
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks.count, 2)
        XCTAssertEqual(hunks[0].header, "@@ -1,1 +1,1 @@")
        XCTAssertEqual(hunks[1].header, "@@ -10,1 +10,1 @@")
    }

    /// UnifiedDiffParser.hunkStarts is private; parse a single-line hunk
    /// header through a synthetic one-row diff and read back the first
    /// row's line numbers to exercise it indirectly.
    private func privateHunkStarts(_ header: String) -> (Int, Int) {
        let hunks = UnifiedDiffParser.parse(header + "\n context")
        return (hunks[0].rows.first?.oldLine ?? -1, hunks[0].rows.first?.newLine ?? -1)
    }
}
