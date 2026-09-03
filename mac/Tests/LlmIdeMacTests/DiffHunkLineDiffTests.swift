import XCTest
@testable import LlmIdeMacLib

final class DiffHunkLineDiffTests: XCTestCase {
    func testIdenticalStringsProduceOneHunkAllContext() {
        let hunks = DiffHunk.fromLineDiff(old: "a\nb\n", new: "a\nb\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .context, oldLine: 2, newLine: 2, text: "b"),
        ])
    }

    func testPureInsertion() {
        let hunks = DiffHunk.fromLineDiff(old: "a\n", new: "a\nb\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 2, text: "b"),
        ])
    }

    func testPureDeletion() {
        let hunks = DiffHunk.fromLineDiff(old: "a\nb\n", new: "a\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .delete, oldLine: 2, newLine: nil, text: "b"),
        ])
    }

    func testModificationIsDeleteThenInsert() {
        let hunks = DiffHunk.fromLineDiff(old: "old\n", new: "new\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .delete, oldLine: 1, newLine: nil, text: "old"),
            DiffRow(kind: .insert, oldLine: nil, newLine: 1, text: "new"),
        ])
    }

    func testEmptyOldIsAllInsertions() {
        let hunks = DiffHunk.fromLineDiff(old: "", new: "a\nb\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows.map(\.kind), [.insert, .insert])
    }

    func testTwoEmptyStringsProduceNoHunks() {
        XCTAssertEqual(DiffHunk.fromLineDiff(old: "", new: ""), [])
    }

    func testCRLFContentSplitsWithoutStrayCarriageReturns() {
        let hunks = DiffHunk.fromLineDiff(old: "a\r\nb\r\n", new: "a\r\nb\r\n")
        XCTAssertEqual(hunks.count, 1)
        XCTAssertEqual(hunks[0].rows, [
            DiffRow(kind: .context, oldLine: 1, newLine: 1, text: "a"),
            DiffRow(kind: .context, oldLine: 2, newLine: 2, text: "b"),
        ])
    }
}
