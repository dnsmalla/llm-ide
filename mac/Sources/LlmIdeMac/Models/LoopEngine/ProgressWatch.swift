import Foundation

/// Tracks, per stage, whether successive failures are getting better or going
/// nowhere — the loop's single stall detector.
///
/// This replaces two hand-rolled trackers that `LoopEngineRunner` used to carry
/// side by side: a per-stage `[stageId: (hash, count)]` map for shell commands,
/// and a separate `lastRegressed`/`regressionStallCount` pair for the regression
/// sweep. They implemented the same idea with different fidelity (the regression
/// path compared a real number and could see progress; the shell path compared a
/// hash and could not), and any fix to one silently left the other behind.
///
/// Semantics, preserving the previous behaviour exactly where it was already
/// right:
/// - A first failure yields `streak == 1`. The caller compares `streak` against
///   `LoopEngineConfig.consecutiveFailureStop`, so `stop == 1` still means
///   "give up on the first failure".
/// - With scores on both sides, a **strictly decreasing** score is progress and
///   resets the streak to 1. Equal-or-worse increments it.
/// - With no score on either side, it falls back to hash equality: a different
///   hash resets, an identical hash increments. That is exactly the old shell
///   behaviour, so an unrecognised test runner loses nothing.
struct ProgressWatch {
    struct Verdict: Equatable {
        /// True when this failure is measurably better than the previous one
        /// (score strictly decreased, or — absent scores — the failure changed).
        let improved: Bool
        /// Consecutive non-improving failures, counting this one. Always ≥ 1.
        let streak: Int
        /// The previous failure's score, when there was one. Fed to the repair
        /// prompt as evidence.
        let previousScore: Int?
    }

    private struct State {
        var score: Int?
        var hash: String
        var streak: Int
    }

    private var state: [String: State] = [:]

    /// Records a failure for `key` and returns the verdict.
    mutating func record(key: String, score: Int?, hash: String) -> Verdict {
        guard let previous = state[key] else {
            state[key] = State(score: score, hash: hash, streak: 1)
            return Verdict(improved: false, streak: 1, previousScore: nil)
        }

        let improved: Bool
        if let score, let previousScore = previous.score {
            improved = score < previousScore
        } else {
            // No comparable score on at least one side — fall back to "is this
            // the same failure text as last time?", the pre-score behaviour.
            improved = hash != previous.hash
        }

        let streak = improved ? 1 : previous.streak + 1
        state[key] = State(score: score, hash: hash, streak: streak)
        return Verdict(improved: improved, streak: streak, previousScore: previous.score)
    }

    /// Forgets `key`'s history. Called when a stage passes, so a later failure in
    /// the same run counts from scratch rather than resuming an old streak.
    mutating func clear(key: String) {
        state[key] = nil
    }

    /// The last recorded score for `key`, if any.
    func lastScore(key: String) -> Int? {
        state[key]?.score
    }
}
