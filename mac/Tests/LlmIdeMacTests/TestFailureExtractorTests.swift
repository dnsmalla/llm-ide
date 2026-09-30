import XCTest
@testable import LlmIdeMacLib

/// Fixtures for swift/node are REAL captured output (tiny failing packages);
/// jest/pytest/go are copied from each runner's documented format.
final class TestFailureExtractorTests: XCTestCase {
    static let swiftTest = #"""
Test Suite 'All tests' started at 2026-09-30 19:14:18.139.
Test Suite 'LibPackageTests.xctest' started at 2026-09-30 19:14:18.141.
Test Suite 'MathTests' started at 2026-09-30 19:14:18.141.
Test Case '-[LibTests.MathTests testOneFails]' started.
pkg/Tests/LibTests/T.swift:6: error: -[LibTests.MathTests testOneFails] : XCTAssertEqual failed: ("1") is not equal to ("2") - one is not two
Test Case '-[LibTests.MathTests testOneFails]' failed (0.044 seconds).
Test Case '-[LibTests.MathTests testOnePasses]' started.
Test Case '-[LibTests.MathTests testOnePasses]' passed (0.000 seconds).
Test Case '-[LibTests.MathTests testTwoFails]' started.
pkg/Tests/LibTests/T.swift:7: error: -[LibTests.MathTests testTwoFails] : XCTAssertTrue failed
Test Case '-[LibTests.MathTests testTwoFails]' failed (0.000 seconds).
Test Suite 'MathTests' failed at 2026-09-30 19:14:18.185.
	 Executed 3 tests, with 2 failures (0 unexpected) in 0.044 (0.044) seconds
Test Suite 'LibPackageTests.xctest' failed at 2026-09-30 19:14:18.185.
	 Executed 3 tests, with 2 failures (0 unexpected) in 0.044 (0.045) seconds
Test Suite 'All tests' failed at 2026-09-30 19:14:18.185.
	 Executed 3 tests, with 2 failures (0 unexpected) in 0.044 (0.046) seconds
◇ Test run started.
↳ Testing Library Version: 1400
↳ Target Platform: arm64e-apple-macos14.0
◇ Suite Sw started.
◇ Test swFails() started.
◇ Test swPasses() started.
✔ Test swPasses() passed after 0.001 seconds.
✘ Test swFails() recorded an issue at T.swift:10:28: Expectation failed: (one() → 1) == 5
✘ Test swFails() failed after 0.001 seconds with 1 issue.
✘ Suite Sw failed after 0.001 seconds with 1 issue.
✘ Test run with 2 tests in 1 suite failed after 0.001 seconds with 1 issue.
"""#
    static let nodeTap = #"""
TAP version 13
# Subtest: adds up
ok 1 - adds up
  ---
  duration_ms: 0.497916
  type: 'test'
  ...
# Subtest: subtracts wrongly
not ok 2 - subtracts wrongly
  ---
  duration_ms: 0.476
  type: 'test'
  location: 'n/a.test.mjs:3:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    2 !== 5
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 5
  actual: 2
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file://n/a.test.mjs:3:42)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: throws
not ok 3 - throws
  ---
  duration_ms: 0.034292
  type: 'test'
  location: 'n/a.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: 'boom'
  code: 'ERR_TEST_FAILURE'
  stack: |-
    TestContext.<anonymous> (file://n/a.test.mjs:4:30)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
1..3
# tests 3
# suites 0
# pass 1
# fail 2
# cancelled 0
# skipped 0
# todo 0
# duration_ms 63.496125
"""#
    static let jest = #"""
FAIL src/math.test.js
  ● math › adds wrongly

    expect(received).toBe(expected) // Object.is equality

    Expected: 5
    Received: 2

      3 |   expect(1 + 1).toBe(5);
        at Object.<anonymous> (src/math.test.js:3:19)

  ● math › throws

    boom
        at Object.<anonymous> (src/math.test.js:6:11)

Tests:       2 failed, 1 passed, 3 total
"""#
    static let pytest = #"""
=================================== FAILURES ===================================
________________________________ test_adds _____________________________________

    def test_adds():
>       assert 1 + 1 == 5
E       assert 2 == 5

tests/test_a.py:3: AssertionError
=========================== short test summary info ============================
FAILED tests/test_a.py::test_adds - assert 2 == 5
FAILED tests/test_a.py::test_other - ValueError: x
========================= 2 failed, 1 passed in 0.03s ==========================
"""#
    static let goTest = #"""
=== RUN   TestAdd
    add_test.go:9: got 2, want 5
--- FAIL: TestAdd (0.00s)
=== RUN   TestOk
--- PASS: TestOk (0.00s)
FAIL
FAIL	example.com/m	0.004s
"""#

    func testXCTestAndSwiftTestingIds() {
        let r = TestFailureExtractor.extract(Self.swiftTest)
        XCTAssertEqual(r.ids, ["LibTests.MathTests/testOneFails", "LibTests.MathTests/testTwoFails", "swFails()"])
        XCTAssertTrue(r.locations.contains("pkg/Tests/LibTests/T.swift:6: XCTAssertEqual failed: (\"1\") is not equal to (\"2\") - one is not two"))
        XCTAssertTrue(r.locations.contains { $0.hasPrefix("T.swift:10: Expectation failed") })
    }

    func testNodeTap() {
        let r = TestFailureExtractor.extract(Self.nodeTap)
        XCTAssertEqual(r.ids, ["subtracts wrongly", "throws"])
        XCTAssertEqual(r.locations, ["n/a.test.mjs:3", "n/a.test.mjs:4"])
    }

    func testJest() {
        let r = TestFailureExtractor.extract(Self.jest)
        XCTAssertEqual(r.ids, ["math › adds wrongly", "math › throws"])
        XCTAssertEqual(r.locations, ["src/math.test.js:3", "src/math.test.js:6"])
    }

    func testPytest() {
        let r = TestFailureExtractor.extract(Self.pytest)
        XCTAssertEqual(r.ids, ["tests/test_a.py::test_adds", "tests/test_a.py::test_other"])
        XCTAssertEqual(r.locations, ["tests/test_a.py:3: AssertionError"])
    }

    func testGo() {
        let r = TestFailureExtractor.extract(Self.goTest)
        XCTAssertEqual(r.ids, ["TestAdd"])
        XCTAssertEqual(r.locations, ["add_test.go:9: got 2, want 5"])
    }

    func testUnrecognisedOutputExtractsNothingAndHashIsNil() {
        XCTAssertEqual(TestFailureExtractor.extract("build exploded\nlinker said no"), TestFailureExtraction())
        XCTAssertNil(TestFailureExtractor.failureSetHash("build exploded"))
    }

    func testFailureSetHashIgnoresOrderAndNoise() {
        let a = TestFailureExtractor.failureSetHash(Self.swiftTest)
        let noisy = Self.swiftTest.replacingOccurrences(of: "0.044", with: "9.999")
        XCTAssertNotNil(a)
        XCTAssertEqual(a, TestFailureExtractor.failureSetHash(noisy))
        XCTAssertNotEqual(a, TestFailureExtractor.failureSetHash(Self.goTest))
        XCTAssertNotEqual(TestFailureExtractor.failureSetHash(Self.pytest),
                          TestFailureExtractor.failureSetHash(Self.pytest.replacingOccurrences(of: "test_other", with: "test_third")))
    }

    func testExcerptReturnsShortOutputWhole() {
        XCTAssertEqual(TestFailureExtractor.repairExcerpt("small", budget: 100), "small")
    }

    func testExcerptKeepsEarlyErrorAndTailWithinBudget() {
        let filler = (0..<2000).map { "noise line \($0)" }.joined(separator: "\n")
        let output = "start\n/p/A.swift:7: error: -[M.C testX] : XCTAssertTrue failed\n" + filler + "\nSUMMARY-AT-END"
        let excerpt = TestFailureExtractor.repairExcerpt(output, budget: 2_000)
        XCTAssertLessThanOrEqual(excerpt.count, 2_000)
        XCTAssertTrue(excerpt.contains("A.swift:7: error"), "early error must survive")
        XCTAssertTrue(excerpt.contains("SUMMARY-AT-END"), "tail must survive")
        XCTAssertFalse(excerpt.contains("noise line 900"))
    }

    func testExcerptDedupesRepeatedErrorLines() {
        let err = "/p/A.swift:7: error: same failure"
        let output = (0..<50).map { _ in err }.joined(separator: "\n") + String(repeating: "\nx", count: 5000)
        let excerpt = TestFailureExtractor.repairExcerpt(output, budget: 1_000)
        XCTAssertEqual(excerpt.components(separatedBy: err).count - 1, 1)
    }

    func testNodeNestedIdsAndTodoSkip() {
        let tap = """
        TAP version 13
        # Subtest: outer
            # Subtest: same
            not ok 1 - same
            # Subtest: fine
            ok 2 - fine
        not ok 1 - outer
        # Subtest: other
            # Subtest: same
            not ok 1 - same
        not ok 2 - other
        not ok 3 - todo thing # TODO not yet
        not ok 4 - skipped # SKIP why
        """
        XCTAssertEqual(TestFailureExtractor.extract(tap).ids,
                       ["other", "other/same", "outer", "outer/same"])
    }

    func testCompilerLocationsAndHeader() {
        let output = "/p/F.swift:12:5: error: cannot find 'x' in scope\n" + String(repeating: "x\n", count: 3000)
        let excerpt = TestFailureExtractor.repairExcerpt(output, budget: 1_000)
        XCTAssertTrue(excerpt.hasPrefix("at: /p/F.swift:12: cannot find 'x' in scope"))
        XCTAssertLessThanOrEqual(excerpt.count, 1_000)
    }

    func testNoCountRunnerScoreDirection() {
        let two = "not ok 1 - a\nnot ok 2 - b"
        let four = two + "\nnot ok 3 - c\nnot ok 4 - d"
        XCTAssertEqual(StageOutputParser.failureScore(four), 4)
        var w = ProgressWatch()
        func rec(_ o: String) -> ProgressWatch.Verdict {
            w.record(key: "s", score: StageOutputParser.failureScore(o), hash: TestFailureExtractor.failureSetHash(o) ?? "")
        }
        _ = rec(two)
        XCTAssertFalse(rec(four).improved)
        XCTAssertTrue(rec(two).improved)
        XCTAssertFalse(rec(two).improved)
    }
}
