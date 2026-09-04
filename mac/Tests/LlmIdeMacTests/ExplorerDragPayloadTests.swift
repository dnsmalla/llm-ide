import XCTest
@testable import LlmIdeMacLib

final class ExplorerDragPayloadTests: XCTestCase {

    func testSingleURLRoundTrips() {
        let url = URL(fileURLWithPath: "/tmp/proj/a.txt")
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode([url]))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/proj/a.txt"])
    }

    func testMultipleURLsRoundTripInOrder() {
        let urls = [URL(fileURLWithPath: "/tmp/a"), URL(fileURLWithPath: "/tmp/b"),
                    URL(fileURLWithPath: "/tmp/c")]
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode(urls))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/a", "/tmp/b", "/tmp/c"])
    }

    /// The CRLF trap: Swift treats "\r\n" as ONE Character, so splitting on
    /// `\.isNewline` yields two paths — splitting on the literal "\n" would
    /// leave a stray "\r" welded onto the first path and target a
    /// nonexistent file.
    func testDecodeHandlesCRLFSeparators() {
        let decoded = ExplorerDragPayload.decode("/tmp/a\r\n/tmp/b")
        XCTAssertEqual(decoded.map(\.path), ["/tmp/a", "/tmp/b"])
    }

    func testDecodeIgnoresBlankLinesAndTrailingSeparator() {
        let decoded = ExplorerDragPayload.decode("/tmp/a\n\n/tmp/b\n")
        XCTAssertEqual(decoded.map(\.path), ["/tmp/a", "/tmp/b"])
    }

    func testDecodeOfEmptyStringIsEmpty() {
        XCTAssertTrue(ExplorerDragPayload.decode("").isEmpty)
        XCTAssertTrue(ExplorerDragPayload.decode("   \n  ").isEmpty)
    }

    /// Spaces are legal in macOS filenames and must survive untouched — a
    /// trim would silently retarget "/tmp/ a .txt".
    func testPathsWithSpacesSurvive() {
        let url = URL(fileURLWithPath: "/tmp/my folder/a file.txt")
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode([url]))
        XCTAssertEqual(decoded.map(\.path), ["/tmp/my folder/a file.txt"])
    }

    /// This project's users work in Japanese. A non-ASCII name must survive
    /// the round trip byte-for-byte — two separate P2 bugs were exactly this
    /// family (`core.quotePath`, octal-escape decoding).
    func testJapanesePathsSurvive() {
        let urls = [URL(fileURLWithPath: "/tmp/設計/設計.txt"),
                    URL(fileURLWithPath: "/tmp/日本語 フォルダ/メモ 1.md")]
        let decoded = ExplorerDragPayload.decode(ExplorerDragPayload.encode(urls))
        XCTAssertEqual(decoded.map(\.path),
                       ["/tmp/設計/設計.txt", "/tmp/日本語 フォルダ/メモ 1.md"])
    }

    /// A newline IS legal in a macOS filename. Percent-encoding means such a
    /// path now ROUND-TRIPS instead of being silently dropped, and — the point
    /// of the encoding — it can never split into two wrong paths, because no
    /// newline reaches the payload at all.
    func testPathsContainingNewlinesRoundTrip() {
        let bad = URL(fileURLWithPath: "/tmp/we\nird.txt")
        let good = URL(fileURLWithPath: "/tmp/fine.txt")
        let payload = ExplorerDragPayload.encode([bad, good])
        XCTAssertEqual(payload.split(whereSeparator: \.isNewline).count, 2,
                       "exactly two records — the embedded newline is escaped, not a separator")
        XCTAssertEqual(ExplorerDragPayload.decode(payload).map(\.path),
                       ["/tmp/we\nird.txt", "/tmp/fine.txt"])
    }

    /// A lone CR and a Unicode line separator are newlines to Swift too, so
    /// they must be escaped for the same reason — otherwise `decode`'s
    /// `\.isNewline` split would tear the path in two.
    func testPathsContainingExoticNewlinesRoundTrip() {
        let cr = URL(fileURLWithPath: "/tmp/we\rird.txt")
        let lineSep = URL(fileURLWithPath: "/tmp/we\u{2028}ird.txt")
        XCTAssertEqual(ExplorerDragPayload.decode(ExplorerDragPayload.encode([cr, lineSep])).map(\.path),
                       ["/tmp/we\rird.txt", "/tmp/we\u{2028}ird.txt"])
    }

    /// `%` is the encoding's OWN escape character, so a filename containing
    /// one is the case most likely to double-decode. It must survive verbatim.
    func testPercentSignsInNamesRoundTrip() {
        let urls = [URL(fileURLWithPath: "/tmp/100%.txt"),
                    URL(fileURLWithPath: "/tmp/a%20b.txt"),
                    URL(fileURLWithPath: "/tmp/%2F not a slash.txt")]
        XCTAssertEqual(ExplorerDragPayload.decode(ExplorerDragPayload.encode(urls)).map(\.path),
                       ["/tmp/100%.txt", "/tmp/a%20b.txt", "/tmp/%2F not a slash.txt"])
    }

    /// A malformed escape (a payload this type did not write) is dropped
    /// rather than half-decoded into a path pointing somewhere unintended.
    func testMalformedEscapesAreDropped() {
        XCTAssertEqual(ExplorerDragPayload.decode("%ZZ\n%2Ftmp%2Fok").map(\.path), ["/tmp/ok"])
    }
}
