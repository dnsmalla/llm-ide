import XCTest
@testable import LlmIdeMacLib

/// The match core. Two classes of bug live here and neither shows up in a
/// compiler: line numbers that are wrong (which makes P4's line-jump land in
/// the wrong place) and a walk that ignores cancellation (design §3 #8).
final class SearchEngineTests: XCTestCase {

    private func regex(_ query: String, options: SearchOptions = SearchOptions()) -> NSRegularExpression {
        // Force-unwrap is fine in a test: an unbuildable pattern is a test bug.
        SearchService.makeRegex(query: query, options: options)!
    }

    // MARK: - lineMatches

    func testLFFileReportsRealLineNumbers() {
        let text = "alpha\nbeta\nneedle\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("needle"), budget: 100)
        XCTAssertEqual(out.lines.map(\.line), [3])
        XCTAssertEqual(out.used, 1)
    }

    /// REGRESSION: `SearchService.walk` split on the literal "\n". Swift
    /// treats "\r\n" as ONE Character, so a CRLF file came back as a single
    /// line and every match was reported on line 1.
    func testCRLFFileReportsRealLineNumbers() {
        let text = "alpha\r\nbeta\r\nneedle\r\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("needle"), budget: 100)
        XCTAssertEqual(out.lines.map(\.line), [3])
        XCTAssertEqual(out.lines.first?.lineText, "needle")
    }

    func testLoneCarriageReturnAlsoSplitsLines() {
        let text = "alpha\rbeta\rneedle"
        let out = SearchEngine.lineMatches(in: text, regex: regex("needle"), budget: 100)
        XCTAssertEqual(out.lines.map(\.line), [3])
    }

    func testMultipleMatchesOnOneLineGetSequentialFileIndexes() {
        let text = "foo bar foo\nfoo\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("foo"), budget: 100)
        XCTAssertEqual(out.used, 3)
        XCTAssertEqual(out.lines.count, 2)
        XCTAssertEqual(out.lines[0].matches.map(\.fileIndex), [0, 1])
        XCTAssertEqual(out.lines[1].matches.map(\.fileIndex), [2])
    }

    func testBudgetCapsMatchesAcrossLines() {
        let text = "foo\nfoo\nfoo\nfoo\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("foo"), budget: 2)
        XCTAssertEqual(out.used, 2)
        XCTAssertEqual(out.lines.map(\.line), [1, 2])
    }

    func testZeroBudgetProducesNothing() {
        let out = SearchEngine.lineMatches(in: "foo\n", regex: regex("foo"), budget: 0)
        XCTAssertTrue(out.lines.isEmpty)
        XCTAssertEqual(out.used, 0)
    }

    func testMultibyteRangesMapBackToTheSameLineText() {
        let text = "前\n出力調整禁止です\n"
        let out = SearchEngine.lineMatches(in: text, regex: regex("出力調整禁止"), budget: 100)
        XCTAssertEqual(out.lines.count, 1)
        let line = out.lines[0]
        let range = Range(line.matches[0].nsRange, in: line.lineText)
        XCTAssertNotNil(range)
        XCTAssertEqual(range.map { String(line.lineText[$0]) }, "出力調整禁止")
    }

    // MARK: - isBinary

    func testIsBinaryDetectsNulByte() {
        XCTAssertTrue(SearchEngine.isBinary(Data([0x41, 0x00, 0x42])))
        XCTAssertFalse(SearchEngine.isBinary(Data("plain text".utf8)))
    }

    // MARK: - scan

    private func candidate(_ name: String) -> SearchEngine.Candidate {
        SearchEngine.Candidate(url: URL(fileURLWithPath: "/tmp/\(name)"), displayPath: name)
    }

    func testScanEmitsOneFileMatchPerMatchingCandidateInOrder() {
        let texts = ["a.txt": "needle\n", "b.txt": "nothing\n", "c.txt": "x\nneedle\n"]
        var emitted: [String] = []
        let outcome = SearchEngine.scan(
            candidates: [candidate("a.txt"), candidate("b.txt"), candidate("c.txt")],
            regex: regex("needle"),
            readText: { texts[$0.lastPathComponent] },
            isCancelled: { false },
            emit: { emitted.append($0.displayPath) })
        XCTAssertEqual(emitted, ["a.txt", "c.txt"])
        XCTAssertEqual(outcome, .completed(totalMatches: 2, fileCount: 2))
    }

    func testScanSkipsUnreadableCandidate() {
        var emitted: [String] = []
        let outcome = SearchEngine.scan(
            candidates: [candidate("binary.bin"), candidate("a.txt")],
            regex: regex("needle"),
            readText: { $0.lastPathComponent == "a.txt" ? "needle\n" : nil },
            isCancelled: { false },
            emit: { emitted.append($0.displayPath) })
        XCTAssertEqual(emitted, ["a.txt"])
        XCTAssertEqual(outcome, .completed(totalMatches: 1, fileCount: 1))
    }

    func testScanStopsAtTheFirstCancelledCheckAndReportsCancelled() {
        var reads = 0
        var emitted = 0
        let outcome = SearchEngine.scan(
            candidates: (0..<50).map { candidate("f\($0).txt") },
            regex: regex("needle"),
            readText: { _ in reads += 1; return "needle\n" },
            isCancelled: { reads >= 3 },
            emit: { _ in emitted += 1 })
        XCTAssertEqual(outcome, .cancelled)
        XCTAssertEqual(reads, 3, "cancellation must be checked BEFORE each file, not after the walk")
        XCTAssertEqual(emitted, 3)
    }

    func testScanReportsTruncatedWhenTheCapIsHit() {
        // One match per file, one more file than the cap allows.
        let candidates = (0..<(SearchEngine.maxMatches + 5)).map { candidate("f\($0).txt") }
        var emitted = 0
        let outcome = SearchEngine.scan(
            candidates: candidates,
            regex: regex("needle"),
            readText: { _ in "needle\n" },
            isCancelled: { false },
            emit: { _ in emitted += 1 })
        XCTAssertEqual(outcome, .truncated(totalMatches: SearchEngine.maxMatches,
                                           fileCount: SearchEngine.maxMatches))
        XCTAssertEqual(emitted, SearchEngine.maxMatches)
    }

    func testFileTextSkipsAnOversizeFile() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("search-engine-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let big = dir.appendingPathComponent("big.txt")
        try String(repeating: "x", count: SearchEngine.maxFileBytes + 10)
            .write(to: big, atomically: true, encoding: .utf8)
        XCTAssertNil(SearchEngine.fileText(at: big))

        let small = dir.appendingPathComponent("small.txt")
        try "hello".write(to: small, atomically: true, encoding: .utf8)
        XCTAssertEqual(SearchEngine.fileText(at: small), "hello")
    }
}
