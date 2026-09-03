import XCTest
@testable import LlmIdeMacLib

final class GitGutterTests: XCTestCase {
    // MARK: - Existing behavior, pinned before extending

    func testPureInsertIsAdded() {
        let diff = """
        @@ -1,2 +1,3 @@
         line1
        +line2
         line3
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [2: .added])
    }

    func testDeleteFollowedByInsertIsModified() {
        let diff = """
        @@ -1,2 +1,2 @@
        -old
        +new
         line3
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [1: .modified])
    }

    // MARK: - New: pure deletion produces a .deleted anchor

    func testPureDeletionMidFileAnchorsAtFollowingLine() {
        let diff = """
        @@ -1,4 +1,3 @@
         line1
        -deleted
         line3
         line4
        """
        // new-side line numbers: line1=1, (deleted has none), line3=2, line4=3.
        // The deletion anchors at the line immediately after it in the NEW
        // file — line 2 (where "line3" now sits).
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [2: .deleted])
    }

    func testPureDeletionAtStartOfHunkAnchorsAtLineOne() {
        let diff = """
        @@ -1,3 +1,2 @@
        -deleted
         line2
         line3
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [1: .deleted])
    }

    func testPureDeletionAtEndOfHunkAnchorsAfterLastSurvivingLine() {
        let diff = """
        @@ -1,3 +1,2 @@
         line1
         line2
        -deleted
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [3: .deleted])
    }

    func testMultipleHunksEachTrackTheirOwnAnchor() {
        let diff = """
        @@ -1,3 +1,2 @@
         line1
        -deleted1
         line3
        @@ -10,3 +9,2 @@
         line10
        -deleted2
         line12
        """
        XCTAssertEqual(GitGutter.changedLines(fromDiff: diff), [2: .deleted, 10: .deleted])
    }
}
