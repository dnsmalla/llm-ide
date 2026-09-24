import XCTest
@testable import LlmIdeMacLib

/// A run stopped at `SearchEngine.maxMatches` holds only a prefix of the
/// truth. The header must say so instead of presenting it as complete.
final class SearchTruncationTests: XCTestCase {

    func testCompleteRunReadsAsATotal() {
        XCTAssertEqual(SearchView.headerSummary(totalMatches: 12, fileCount: 3, truncated: false),
                       "12 results in 3 files")
    }

    func testTruncatedRunSaysItIsAPrefix() {
        let text = SearchView.headerSummary(totalMatches: SearchEngine.maxMatches,
                                            fileCount: 40, truncated: true)
        XCTAssertTrue(text.hasPrefix("Showing first \(SearchEngine.maxMatches) matches"), text)
        XCTAssertFalse(text.contains("results in"), "a truncated run must not read as a complete total")
    }
}
