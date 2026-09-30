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
            StageOutputParser.parseFailureCount("Test Suite 'All tests' failed at 2026-09-30 10:00:00.000.\nExecuted 16 tests, with 1 failure (0 unexpected) in 0.005 seconds"),
            1)
    }

    /// A passing XCTest run must score 0, not nil: "recognised and zero" and
    /// "unrecognised" drive different code paths in the runner.
    func testXCTestZeroFailuresScoresZeroNotNil() {
        XCTAssertEqual(
            StageOutputParser.parseFailureCount("Test Suite 'All tests' passed at 2026-09-30 10:00:00.000.\nExecuted 294 tests, with 0 failures (0 unexpected) in 3.4 seconds"),
            0)
    }

    func testSwiftTestingIssueCount() {
        let output = "✘ Test run with 12 tests failed after 0.5 seconds with 3 issues."
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 3)
    }

    /// XCTest prints a summary per suite and the aggregate LAST; the first
    /// match is only the first suite's count.
    func testXCTestMultiSuiteUsesTheLastSummary() {
        let output = """
        Test Suite 'AlphaTests' failed at 2026-09-30 10:00:00.000.
        \t Executed 4 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds
        Test Suite 'BetaTests' failed at 2026-09-30 10:00:01.000.
        \t Executed 6 tests, with 2 failures (0 unexpected) in 0.2 (0.2) seconds
        Test Suite 'All tests' failed at 2026-09-30 10:00:01.000.
        \t Executed 10 tests, with 3 failures (0 unexpected) in 0.3 (0.3) seconds
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 3)
    }

    /// A run with skipped tests words the summary differently; it must still
    /// be recognised (this repo's own suite has a skip).
    func testXCTestSummaryWithSkippedTests() {
        XCTAssertEqual(StageOutputParser.parseFailureCount(
            "Test Suite 'All tests' failed at 2026-09-30 10:00:00.000.\n\t Executed 1508 tests, with 1 test skipped and 2 failures (0 unexpected) in 69.4 (69.5) seconds"), 2)
        XCTAssertEqual(StageOutputParser.parseFailureCount(
            "Test Suite 'All tests' failed at 2026-09-30 10:00:00.000.\n\t Executed 1508 tests, with 3 tests skipped and 0 failures (0 unexpected) in 69.4 (69.5) seconds"), 0)
    }

    /// A crash leaves per-suite lines but no run-wide total: the count is
    /// unknown (nil), never the partial sum of the suites that finished.
    func testXCTestCrashWithOnlyPerSuiteLinesIsUnknown() {
        let output = """
        Test Suite 'AlphaTests' failed at 2026-09-30 10:00:00.000.
        \t Executed 4 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds
        Test Case '-[BetaTests testBoom]' started.
        Fatal error: Unexpectedly found nil while unwrapping an Optional value
        error: Exited with unexpected signal code 4
        """
        XCTAssertNil(StageOutputParser.parseFailureCount(output))
    }

    func testSelectedTestsTotalIsUsedUnderAFilter() {
        let output = """
        Test Suite 'AlphaTests' failed at 2026-09-30 10:00:00.000.
        \t Executed 4 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds
        Test Suite 'Selected tests' failed at 2026-09-30 10:00:01.000.
        \t Executed 4 tests, with 1 failure (0 unexpected) in 0.1 (0.1) seconds
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 1)
    }

    /// `swift test` runs both frameworks; the failures are the sum.
    func testXCTestAndSwiftTestingFailuresAreSummed() {
        let output = """
        Test Suite 'All tests' failed at 2026-09-30 10:00:01.000.
        \t Executed 10 tests, with 2 failures (0 unexpected) in 0.3 (0.3) seconds
        ✘ Test run with 20 tests in 4 suites failed after 0.8 seconds with 5 issues.
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 7)
    }

    func testXCTestFailuresWithPassingSwiftTesting() {
        let output = """
        Test Suite 'All tests' failed at 2026-09-30 10:00:01.000.
        \t Executed 10 tests, with 2 failures (0 unexpected) in 0.3 (0.3) seconds
        ✔ Test run with 20 tests in 4 suites passed after 0.8 seconds.
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 2)
    }

    func testSwiftTestingFailuresWithPassingXCTest() {
        let output = """
        Test Suite 'All tests' failed at 2026-09-30 10:00:01.000.
        \t Executed 10 tests, with 0 failures (0 unexpected) in 0.3 (0.3) seconds
        ✘ Test run with 20 tests in 4 suites failed after 0.8 seconds with 1 issue.
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 1)
    }

    func testSwiftTestingPassingSummaryScoresZero() {
        XCTAssertEqual(
            StageOutputParser.parseFailureCount("✔ Test run with 0 tests in 0 suites passed after 0.001 seconds."),
            0)
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
        Test Suite 'All tests' failed at 2026-09-30 10:00:00.000.
        Executed 10 tests, with 7 failures (0 unexpected) in 1.0 seconds
        """
        XCTAssertEqual(StageOutputParser.parseFailureCount(output), 7)
    }
}
