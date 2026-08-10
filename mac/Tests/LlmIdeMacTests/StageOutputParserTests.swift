import XCTest
@testable import LlmIdeMacLib

/// The score `StageOutputParser` extracts is the loop's primary progress signal:
/// a wrong number makes `LoopEngineRunner` believe a repair helped (or didn't)
/// when the opposite is true, and a wrongly-`nil` answer silently drops the loop
/// back to hash comparison. Both failure modes are invisible without these.
final class StageOutputParserTests: XCTestCase {

    // MARK: - Recognised runners

    func testXCTestFailureSummary() {
        let output = "Test Suite 'All tests' failed.\n\t Executed 294 tests, with 2 failures (0 unexpected) in 3.493 (3.514) seconds"
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 2)
    }

    func testXCTestSingularFailure() {
        XCTAssertEqual(
            StageOutputParser.parseFailureCount("Executed 16 tests, with 1 failure (0 unexpected) in 0.005 seconds"),
            1)
    }

    /// A passing XCTest run must score 0, not nil: "recognised and zero" and
    /// "unrecognised" drive different code paths in the runner.
    func testXCTestZeroFailuresScoresZeroNotNil() {
        XCTAssertEqual(
            StageOutputParser.parseFailureCount("Executed 294 tests, with 0 failures (0 unexpected) in 3.4 seconds"),
            0)
    }

    func testSwiftTestingIssueCount() {
        let output = "✘ Test run with 12 tests failed after 0.5 seconds with 3 issues."
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 3)
    }

    func testNodeTestTapSummary() {
        let output = """
        # tests 203
        # pass 200
        # fail 3
        # cancelled 0
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 3)
    }

    func testPytestSummaryLine() {
        XCTAssertEqual(
            StageOutputParser.parseFailureCount("=========== 4 failed, 9 passed in 1.23s ============"),
            4)
    }

    func testJestSummaryLine() {
        XCTAssertEqual(
            StageOutputParser.parseFailureCount("Tests:       3 failed, 9 passed, 12 total"),
            3)
    }

    /// `go test` prints no aggregate count, so each `--- FAIL:` line counts as one.
    func testGoTestCountsFailLines() {
        let output = """
        --- FAIL: TestAlpha (0.00s)
        --- FAIL: TestBeta (0.01s)
        FAIL
        FAIL\texample.com/pkg\t0.012s
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 2)
    }

    // MARK: - Unrecognised output

    /// The load-bearing negative case: returning `nil` (not 0) is what keeps the
    /// runner on its pre-existing hash-comparison path for runners this parser
    /// does not know, so adding the parser cannot regress them.
    func testUnrecognisedOutputReturnsNil() {
        XCTAssertNil(StageOutputParser.parseFailureCount("ld: symbol(s) not found for architecture arm64"))
        XCTAssertNil(StageOutputParser.parseFailureCount(""))
        XCTAssertNil(StageOutputParser.parseFailureCount("identical failure"))
    }

    /// These two strings are exactly what `LoopEngineRunnerTests` uses to exercise
    /// the hash fallback. If the parser ever started scoring them, those tests
    /// would silently change which code path they cover.
    func testStringsUsedByHashFallbackTestsStayUnscored() {
        XCTAssertNil(StageOutputParser.parseFailureCount("FAILED in 0.5s"))
        XCTAssertNil(StageOutputParser.parseFailureCount("3 failures"))
        XCTAssertNil(StageOutputParser.parseFailureCount("1 failure"))
    }

    /// The XCTest pattern is checked before pytest's much looser `N failed`, so a
    /// log containing both shapes reports the XCTest count rather than whichever
    /// happened to appear first in the text.
    func testMostSpecificPatternWins() {
        let output = """
        1 failed
        Executed 10 tests, with 7 failures (0 unexpected) in 1.0 seconds
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 7)
    }
}
