import XCTest
@testable import LlmIdeMacLib

/// `ProgressWatch` decides when the loop gives up. Too eager and it abandons a
/// repair that was working; too lax and it burns every iteration (and every LLM
/// call) on a stage that will never improve. It also replaced two separate
/// trackers in `LoopEngineRunner`, so these tests pin the previous behaviour of
/// both to prove the unification changed nothing it shouldn't have.
final class ProgressWatchTests: XCTestCase {

    // MARK: - First failure

    /// A first failure must report streak 1, not 0 — callers compare against
    /// `consecutiveFailureStop`, so streak 0 would make `stop == 1` unreachable.
    func testFirstFailureHasStreakOne() {
        var watch = ProgressWatch()
        let verdict = watch.record(key: "a", score: 5, hash: "h1")
        XCTAssertEqual(verdict.streak, 1)
        XCTAssertFalse(verdict.improved)
        XCTAssertNil(verdict.previousScore)
    }

    // MARK: - Score path

    func testStrictlyDecreasingScoreResetsStreak() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: 5, hash: "h1")
        let verdict = watch.record(key: "a", score: 3, hash: "h2")
        XCTAssertTrue(verdict.improved)
        XCTAssertEqual(verdict.streak, 1)
        XCTAssertEqual(verdict.previousScore, 5)
    }

    /// Equal score is NOT progress even when the failure text changed — this is
    /// exactly the thrashing case the old hash-only comparison could not see.
    func testEqualScoreWithDifferentHashStillCountsAsNoProgress() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: 3, hash: "h1")
        let verdict = watch.record(key: "a", score: 3, hash: "totally-different")
        XCTAssertFalse(verdict.improved)
        XCTAssertEqual(verdict.streak, 2)
    }

    func testRisingScoreCountsAsNoProgress() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: 3, hash: "h1")
        let verdict = watch.record(key: "a", score: 7, hash: "h2")
        XCTAssertFalse(verdict.improved)
        XCTAssertEqual(verdict.streak, 2)
    }

    func testStreakAccumulatesAcrossRepeatedNonImprovement() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: 3, hash: "h1")
        _ = watch.record(key: "a", score: 3, hash: "h1")
        XCTAssertEqual(watch.record(key: "a", score: 3, hash: "h1").streak, 3)
    }

    // MARK: - Hash fallback (unrecognised runner)

    /// With no score, behaviour must be identical to the pre-score
    /// implementation: same hash increments, different hash resets.
    func testNilScoreFallsBackToHashEquality() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: nil, hash: "same")
        let repeated = watch.record(key: "a", score: nil, hash: "same")
        XCTAssertFalse(repeated.improved)
        XCTAssertEqual(repeated.streak, 2)

        let changed = watch.record(key: "a", score: nil, hash: "different")
        XCTAssertTrue(changed.improved)
        XCTAssertEqual(changed.streak, 1)
    }

    /// A stage whose output only becomes parseable partway through a run (e.g. a
    /// build error first, then real test output) has a score on one side only —
    /// which must fall back to hash comparison rather than crash or guess.
    func testScoreOnOnlyOneSideFallsBackToHash() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: nil, hash: "h1")
        let verdict = watch.record(key: "a", score: 4, hash: "h2")
        XCTAssertTrue(verdict.improved)      // different hash
        XCTAssertNil(verdict.previousScore)
    }

    // MARK: - Per-key isolation and clearing

    func testKeysAreTrackedIndependently() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: nil, hash: "same")
        // Stage b's first failure happens to look identical to stage a's. It must
        // still be b's FIRST failure, not a's second.
        let b = watch.record(key: "b", score: nil, hash: "same")
        XCTAssertEqual(b.streak, 1)
    }

    func testClearForgetsHistorySoALaterFailureStartsOver() {
        var watch = ProgressWatch()
        _ = watch.record(key: "a", score: 3, hash: "h1")
        _ = watch.record(key: "a", score: 3, hash: "h1")
        watch.clear(key: "a")
        // The next failure is a FIRST failure again, not a resumed streak of 3.
        XCTAssertEqual(watch.record(key: "a", score: 3, hash: "h1").streak, 1)
    }

}
