import XCTest
@testable import LlmIdeMacLib

/// Replace must change exactly the matches the search listed. The search
/// matches line by line; replace used to re-match the whole file and pick a
/// match by ordinal, so a pattern that can span a newline shifted every
/// ordinal and "Replace" on one row edited a different occurrence.
final class SearchReplaceTests: XCTestCase {

    private func regex(_ query: String, _ options: SearchOptions = SearchOptions()) -> NSRegularExpression {
        SearchService.makeRegex(query: query, options: options)!
    }

    private let regexMode = SearchOptions(regex: true)

    /// REGRESSION: `a\s*b` matches "a\nb" across lines when the whole file
    /// is matched, but the search (per line) only ever showed "a b" on line 2.
    func testReplaceOneHitsTheListedMatchNotAFileWideOrdinal() throws {
        let text = "a\nb a b\n"
        let found = SearchEngine.lineMatches(in: text, regex: regex("a\\s*b", regexMode), budget: 100)
        XCTAssertEqual(found.lines.map(\.line), [2])
        let line = try XCTUnwrap(found.lines.first)
        let out = SearchEngine.replacingOne(in: text, line: line.line,
                                            rangeInLine: line.matches[0].nsRange,
                                            regex: regex("a\\s*b", regexMode), replacement: "X",
                                            options: regexMode, preserveCase: false)
        XCTAssertEqual(out, "a\nb X\n")
    }

    func testReplaceOnePicksTheSecondMatchOnALine() {
        let text = "foo foo\n"
        let out = SearchEngine.replacingOne(in: text, line: 1,
                                            rangeInLine: NSRange(location: 4, length: 3),
                                            regex: regex("foo"), replacement: "bar",
                                            options: SearchOptions(), preserveCase: false)
        XCTAssertEqual(out, "foo bar\n")
    }

    func testReplaceOneRefusesAStaleRange() {
        // The file changed since the search: nothing matches at that spot.
        let out = SearchEngine.replacingOne(in: "xx foo\n", line: 1,
                                            rangeInLine: NSRange(location: 0, length: 3),
                                            regex: regex("foo"), replacement: "bar",
                                            options: SearchOptions(), preserveCase: false)
        XCTAssertNil(out)
        XCTAssertNil(SearchEngine.replacingOne(in: "foo\n", line: 9,
                                               rangeInLine: NSRange(location: 0, length: 3),
                                               regex: regex("foo"), replacement: "bar",
                                               options: SearchOptions(), preserveCase: false))
    }

    func testReplaceOneKeepsCRLFAndExpandsTemplatesAgainstTheLine() {
        let text = "one\r\nkey=value\r\n"
        let out = SearchEngine.replacingOne(in: text, line: 2,
                                            rangeInLine: NSRange(location: 0, length: 9),
                                            regex: regex("(\\w+)=(\\w+)", regexMode),
                                            replacement: "$2=$1",
                                            options: regexMode, preserveCase: false)
        XCTAssertEqual(out, "one\r\nvalue=key\r\n")
    }

    func testReplaceAllDoesNotTouchMatchesThatSpanLines() {
        let out = SearchEngine.replacingAll(in: "a\nb a b\n", regex: regex("a\\s*b", regexMode),
                                            replacement: "X", options: regexMode, preserveCase: false)
        XCTAssertEqual(out?.text, "a\nb X\n")
        XCTAssertEqual(out?.count, 1)
    }

    func testReplaceAllIsLiteralInPlainModeAndPreservesCase() {
        let plain = SearchEngine.replacingAll(in: "foo Foo FOO", regex: regex("foo"),
                                              replacement: "$1bar", options: SearchOptions(),
                                              preserveCase: false)
        XCTAssertEqual(plain?.text, "$1bar $1bar $1bar")
        let cased = SearchEngine.replacingAll(in: "foo Foo FOO", regex: regex("foo"),
                                              replacement: "bar", options: SearchOptions(),
                                              preserveCase: true)
        XCTAssertEqual(cased?.text, "bar Bar BAR")
    }

    func testReplaceAllReturnsNilWhenNothingMatches() {
        XCTAssertNil(SearchEngine.replacingAll(in: "abc\n", regex: regex("zzz"), replacement: "y",
                                               options: SearchOptions(), preserveCase: false))
    }

    // MARK: - On disk

    private func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("search-replace-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    @MainActor
    func testServiceReplacesOnDiskAndReportsChangedFiles() async throws {
        let dir = try tempDir()
        let a = dir.appendingPathComponent("a.txt"), b = dir.appendingPathComponent("b.txt")
        try "foo\nfoo foo\n".write(to: a, atomically: true, encoding: .utf8)
        try "nothing\n".write(to: b, atomically: true, encoding: .utf8)
        let service = SearchService()
        let files = [a, b].map { FileMatch(url: $0, displayPath: $0.lastPathComponent, lineMatches: []) }
        let changed = await service.replaceAll(in: files, query: "foo", options: SearchOptions(),
                                               replacement: "bar", preserveCase: false)
        XCTAssertEqual(changed, 1, "a file with no match is not counted or rewritten")
        XCTAssertEqual(try String(contentsOf: a, encoding: .utf8), "bar\nbar bar\n")

        let one = await service.replaceOne(file: a, line: 2, rangeInLine: NSRange(location: 4, length: 3),
                                           query: "bar", options: SearchOptions(),
                                           replacement: "baz", preserveCase: false)
        XCTAssertTrue(one)
        XCTAssertEqual(try String(contentsOf: a, encoding: .utf8), "bar\nbar baz\n")
    }

    func testAtomicWriteKeepsPermissionsAndWritesThroughASymlink() throws {
        let dir = try tempDir()
        let script = dir.appendingPathComponent("run.sh")
        try "echo old\n".write(to: script, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
        let link = dir.appendingPathComponent("link.sh")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: script)

        XCTAssertTrue(SearchService.writeAtomically("echo new\n", to: link))

        XCTAssertEqual(try String(contentsOf: script, encoding: .utf8), "echo new\n")
        let linkType = try FileManager.default.attributesOfItem(atPath: link.path)[.type] as? FileAttributeType
        XCTAssertEqual(linkType, .typeSymbolicLink, "the symlink must survive the rename")
        let perms = try FileManager.default.attributesOfItem(atPath: script.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(perms?.intValue, 0o755)
    }
}
