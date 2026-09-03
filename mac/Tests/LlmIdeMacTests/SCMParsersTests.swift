import XCTest
@testable import LlmIdeMacLib

/// StatusParser/UnifiedDiffParser feed GitTruthStore, GitGutter, and
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

    /// `path` is the NEW path, and the old one is retained in
    /// `renamedFrom` rather than discarded — the changes list renders
    /// "old → new" from it.
    func testRenameKeepsNewPathAndRetainsTheOldOne() {
        let changes = StatusParser.parse(porcelain: "R  old.txt -> new.txt")
        XCTAssertEqual(changes, [FileChange(path: "new.txt", status: .renamed, staged: true,
                                            renamedFrom: "old.txt")])
    }

    func testNonRenameHasNilRenamedFrom() {
        XCTAssertNil(StatusParser.parse(porcelain: " M path.txt").first?.renamedFrom)
    }

    /// git quotes each side of the arrow INDEPENDENTLY — `R  norm.txt ->
    /// "plain new.txt"` is verbatim real output — so both sides have to be
    /// unquoted separately, not as one joined string.
    func testRenameUnquotesEachSideIndependently() {
        let changes = StatusParser.parse(porcelain: "R  norm.txt -> \"plain new.txt\"")
        XCTAssertEqual(changes, [FileChange(path: "plain new.txt", status: .renamed, staged: true,
                                            renamedFrom: "norm.txt")])
    }

    /// A rename of a Japanese-named file: both sides arrive octal-escaped
    /// and both must decode, or the row reads "\346… → \346…".
    func testRenameOfNonASCIIPathsDecodesBothSides() {
        let porcelain = "R  \"\\350\\250\\255\\350\\250\\210.txt\" -> \"\\346\\226\\260\\350\\250\\255\\350\\250\\210.txt\""
        XCTAssertEqual(StatusParser.parse(porcelain: porcelain),
                       [FileChange(path: "新設計.txt", status: .renamed, staged: true,
                                   renamedFrom: "設計.txt")])
    }

    /// `" -> "` is a legal substring of a FILENAME, and git emits the
    /// separator only for R and C. Searching for it ungated split ordinary
    /// lines apart: ` M "arrow -> weird.txt"` (verbatim git output — the
    /// spaces are why git quotes it) parsed to the path `weird.txt"`, which
    /// exists nowhere, so the row rendered wrong and `git add`/`git restore`
    /// against it failed. Untracked and conflicted lines were hit too.
    func testArrowInFileNameIsNotSplitOnNonRenameLines() {
        XCTAssertEqual(StatusParser.parse(porcelain: " M \"arrow -> weird.txt\""),
                       [FileChange(path: "arrow -> weird.txt", status: .modified, staged: false)])
        XCTAssertEqual(StatusParser.parse(porcelain: "M  \"arrow -> weird.txt\""),
                       [FileChange(path: "arrow -> weird.txt", status: .modified, staged: true)])
        XCTAssertEqual(StatusParser.parse(porcelain: "?? \"new -> thing.txt\""),
                       [FileChange(path: "new -> thing.txt", status: .untracked, staged: false)])
        XCTAssertEqual(StatusParser.parse(porcelain: "UU \"a -> b.txt\""),
                       [FileChange(path: "a -> b.txt", status: .conflicted, staged: false)])
    }

    /// The gate must not cost a real rename INTO such a name: the first
    /// `" -> "` there IS the separator.
    func testRenameIntoAnArrowNamedFileStillSplits() {
        let changes = StatusParser.parse(porcelain: "R  src.txt -> \"arrow -> weird.txt\"")
        XCTAssertEqual(changes, [FileChange(path: "arrow -> weird.txt", status: .renamed,
                                            staged: true, renamedFrom: "src.txt")])
    }

    /// Copy detection (`status.renames=copies`) emits the same
    /// "old -> new" shape under status code C, so C splits too.
    func testCopyStatusAlsoSplitsOnTheArrow() {
        XCTAssertEqual(StatusParser.parse(porcelain: "C  src.txt -> copy.txt").first?.path, "copy.txt")
    }

    /// "RM" = renamed in the index, modified in the worktree. Only the
    /// staged row describes the rename; the unstaged row is an ordinary
    /// modification of the NEW path and must not claim `renamedFrom`.
    func testRenamePlusWorktreeModificationTagsOnlyTheStagedSide() {
        let changes = StatusParser.parse(porcelain: "RM old.txt -> new.txt")
        XCTAssertEqual(changes, [
            FileChange(path: "new.txt", status: .renamed, staged: true, renamedFrom: "old.txt"),
            FileChange(path: "new.txt", status: .modified, staged: false),
        ])
    }

    func testQuotedPathIsUnquoted() {
        let changes = StatusParser.parse(porcelain: "M  \"path with spaces.txt\"")
        XCTAssertEqual(changes, [FileChange(path: "path with spaces.txt", status: .modified, staged: true)])
    }

    /// git's default `core.quotePath` renders every non-ASCII byte as a
    /// three-digit octal escape, so `設計.txt` arrives as
    /// `"\350\250\255\350\250\210.txt"` (captured verbatim from a real
    /// repo). Stripping only the quotes left that backslash soup as the
    /// path: Japanese-named files rendered as octal garbage in the changes
    /// list and could not be staged/unstaged/discarded, because the path
    /// handed to `git add` did not exist on disk.
    func testOctalEscapedNonASCIIPathIsDecoded() {
        let changes = StatusParser.parse(porcelain: "M  \"\\350\\250\\255\\350\\250\\210.txt\"")
        XCTAssertEqual(changes, [FileChange(path: "設計.txt", status: .modified, staged: true)])
    }

    /// A non-ASCII path that ALSO contains a space: git quotes the whole
    /// thing and escapes only the high bytes, so the decoder must copy the
    /// literal space through untouched while decoding around it.
    func testNonASCIIPathWithSpaceIsDecoded() {
        let porcelain = "A  \"\\346\\227\\245\\346\\234\\254\\350\\252\\236 \\343\\203\\206\\343\\202\\271\\343\\203\\210.txt\""
        XCTAssertEqual(StatusParser.parse(porcelain: porcelain),
                       [FileChange(path: "日本語 テスト.txt", status: .added, staged: true)])
    }

    /// `\"` and `\\` are C-style escapes, not literal backslash sequences.
    func testEscapedQuoteAndBackslashInPathAreDecoded() {
        XCTAssertEqual(StatusParser.parse(porcelain: "M  \"a\\\"b.txt\"").first?.path, "a\"b.txt")
        XCTAssertEqual(StatusParser.parse(porcelain: "M  \"a\\\\b.txt\"").first?.path, "a\\b.txt")
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

    /// Asserts the row's CONTENT, not just the count: Swift treats "\r\n" as one
    /// Character, so a `removeLast(2)` terminator strip silently ate the last line's
    /// final letter ("new" → "ne") — which a count-only assertion passed straight
    /// over.
    func testCRLFTerminatorIsAlsoDropped() {
        let hunks = UnifiedDiffParser.parse("@@ -1,1 +1,1 @@\n+new\r\n")
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .insert, oldLine: nil, newLine: 1, text: "new"),
        ])
    }

    /// A diff from a CRLF checkout: every break is "\r\n". Splitting on the "\n"
    /// Character never matched those at all, so the whole diff parsed as a single
    /// unsplit line and the file showed one garbage row.
    func testAllCRLFDiffIsSplitIntoRows() {
        let hunks = UnifiedDiffParser.parse("@@ -1,2 +1,2 @@\r\n line1\r\n-old\r\n+new\r\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "line1"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "old"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 2, text: "new"),
        ])
    }

    /// A lone-CR (classic Mac) break counts as a break too, so such a diff is not
    /// parsed as one line either.
    func testLoneCarriageReturnIsTreatedAsALineBreak() {
        let hunks = UnifiedDiffParser.parse("@@ -1,1 +1,1 @@\r+new\r")
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .insert, oldLine: nil, newLine: 1, text: "new"),
        ])
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

    // MARK: - Header skipping must not reach inside an open hunk
    //
    // Every row inside a hunk carries a prefix character, so a DELETED line
    // whose content starts with "-- " renders as "--- …" and an INSERTED one
    // starting with "++" renders as "+++ …". Skipping those as file headers
    // dropped the row entirely: the hunk list claimed "no change" for a line
    // Monaco showed as deleted, and — since P2 rebuilds patches from these
    // rows — `git apply` rejected the synthesized hunk with "corrupt patch"
    // (status 128) because the body no longer matched its own "@@" counts.
    // "-- comment" is idiomatic SQL, Lua, Haskell, Ada, Elm and VHDL.

    func testDeletedSQLCommentIsNotMistakenForAFileHeader() {
        let diff = """
        diff --git a/q.sql b/q.sql
        index 1111111..2222222 100644
        --- a/q.sql
        +++ b/q.sql
        @@ -1,5 +1,4 @@
         select 1;
        --- drop me
         select 2;
         select 3;
         select 4;
        """
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "select 1;"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "-- drop me"),
            DiffRow(kind: .context, oldLine: 3, newLine: 2, text: "select 2;"),
            DiffRow(kind: .context, oldLine: 4, newLine: 3, text: "select 3;"),
            DiffRow(kind: .context, oldLine: 5, newLine: 4, text: "select 4;"),
        ])
    }

    func testInsertedDoublePlusLineIsNotMistakenForAFileHeader() {
        let hunks = UnifiedDiffParser.parse("@@ -1,1 +1,2 @@\n int a;\n+++counter;\n")
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "int a;"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 2, text: "++counter;"),
        ])
    }

    /// The adversarial case: the deleted lines are VERBATIM file headers.
    /// Only the "@@" counts can tell them apart from real ones, which is
    /// exactly why the parser now tracks them.
    func testDeletedLinesThatAreLiterallyFileHeadersSurvive() {
        let diff = """
        @@ -1,4 +1,2 @@
         intro
        ---- a/fake.txt
        -+++ b/fake.txt
         outro
        """
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "intro"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "--- a/fake.txt"),
            DiffRow(kind: .delete, oldLine: 3, newLine: nil, text: "+++ b/fake.txt"),
            DiffRow(kind: .context, oldLine: 4, newLine: 2, text: "outro"),
        ])
    }

    /// A multi-file diff still finds the SECOND file's headers, because the
    /// first hunk's budget is spent by then. Without this the fix would trade
    /// one dropped-row bug for a merged-hunks bug.
    func testMultiFileDiffStillSplitsOnceTheHunkBudgetIsSpent() {
        let diff = """
        diff --git a/x.txt b/x.txt
        --- a/x.txt
        +++ b/x.txt
        @@ -1,3 +1,3 @@
         1
        -2
        +X
         3
        diff --git a/y.txt b/y.txt
        --- a/y.txt
        +++ b/y.txt
        @@ -1,3 +1,3 @@
         a
        -b
        +Y
         c
        """
        let hunks = UnifiedDiffParser.parse(diff)
        XCTAssertEqual(hunks.count, 2)
        XCTAssertEqual(hunks[0].rows.map(\.text), ["1", "2", "X", "3"])
        XCTAssertEqual(hunks[1].rows.map(\.text), ["a", "b", "Y", "c"])
    }

    /// `\ No newline at end of file` is hunk metadata: skipped, and counting
    /// toward NEITHER side's budget — otherwise it would end the hunk one row
    /// early and drop the last real line.
    func testNoNewlineMarkerIsSkippedWithoutSpendingTheBudget() {
        let diff = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n\\ No newline at end of file\n"
        XCTAssertEqual(UnifiedDiffParser.parse(diff)[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "one"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "two"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 2, text: "TWO"),
            DiffRow(kind: .context, oldLine: 3, newLine: 3, text: "three"),
        ])
    }

    /// A hunk whose header UNDERSTATES its counts (hand-written or
    /// model-generated) keeps the leniency it has always had: rows past the
    /// budget are still collected, they just resume being header-skippable.
    func testRowsPastAnUnderstatedBudgetAreStillCollected() {
        let hunks = UnifiedDiffParser.parse("@@ -1,1 +1,1 @@\n-old\n+new\n extra\n")
        XCTAssertEqual(hunks[0].rows.map(\.text), ["old", "new", "extra"])
    }

    // MARK: - hunkRanges

    func testHunkRangesReadsBothRanges() {
        let r = UnifiedDiffParser.hunkRanges("@@ -10,5 +12,6 @@ func add() -> Int {")
        XCTAssertEqual(r?.oldStart, 10); XCTAssertEqual(r?.oldCount, 5)
        XCTAssertEqual(r?.newStart, 12); XCTAssertEqual(r?.newCount, 6)
    }

    /// git's comma-less shorthand means exactly ONE line, not zero — reading
    /// it as zero would make a single-line hunk look like a whole-file add or
    /// delete and get it refused by `GitTruthStore.assertPatchable`.
    func testHunkRangesTreatsACommalessRangeAsOneLine() {
        let r = UnifiedDiffParser.hunkRanges("@@ -1 +1 @@")
        XCTAssertEqual(r?.oldCount, 1); XCTAssertEqual(r?.newCount, 1)
    }

    func testHunkRangesKeepsZeroCountsForWholeFileAddsAndDeletes() {
        XCTAssertEqual(UnifiedDiffParser.hunkRanges("@@ -0,0 +1,5 @@")?.oldCount, 0)
        XCTAssertEqual(UnifiedDiffParser.hunkRanges("@@ -1,5 +0,0 @@")?.newCount, 0)
    }

    /// nil, not a guess. A combined diff's second range is another OLD side,
    /// not a new one, so there is no honest answer to give.
    func testHunkRangesRejectsWhatItCannotRead() {
        XCTAssertNil(UnifiedDiffParser.hunkRanges(""))
        XCTAssertNil(UnifiedDiffParser.hunkRanges("@@ -1,3 @@"))
        XCTAssertNil(UnifiedDiffParser.hunkRanges("@@@ -1,3 -1,3 +1,4 @@@"))
        XCTAssertNil(UnifiedDiffParser.hunkRanges("@@ -x,y +1,2 @@"))
    }

    /// UnifiedDiffParser.hunkRanges is exercised directly above; this keeps
    /// the original indirect check that a trailing function context can't
    /// clobber the two range tokens.
    private func privateHunkStarts(_ header: String) -> (Int, Int) {
        let hunks = UnifiedDiffParser.parse(header + "\n context")
        return (hunks[0].rows.first?.oldLine ?? -1, hunks[0].rows.first?.newLine ?? -1)
    }
}
