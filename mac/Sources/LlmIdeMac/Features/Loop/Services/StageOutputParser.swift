import Foundation

/// Extracts a numeric failure count from a test runner's output.
///
/// Why the loop needs this: without a score, `LoopEngineRunner` can only ask
/// "is this failure byte-identical to the last one?" (`LoopEngineRunner.hash`).
/// That cannot tell "7 failures → 3 failures" (real progress, keep going) apart
/// from "7 failures → 7 different failures" (thrashing, stop) — both look like
/// "a different failure". A monotonically shrinking count is the canonical
/// evidence a repair is working, so the loop steers on it when it can, and the
/// repair prompt quotes it back to the agent as evidence.
///
/// Returns `nil` for output this parser does not recognise. `nil` is a
/// first-class answer, not a failure: the runner falls back to hash comparison,
/// which is exactly today's behaviour, so an unrecognised runner is never made
/// worse by this existing.
enum StageOutputParser {
    /// One recognised runner: the regex, and which capture group holds the
    /// failure count.
    private struct Pattern {
        let regex: String
        let group: Int
    }

    /// Ordered most-specific first. Every pattern is anchored on wording that
    /// only appears in that runner's summary line, so two runners' output in one
    /// log (e.g. a `make test` that runs both) cannot cross-match.
    private static let patterns: [Pattern] = [
        // XCTest: "Executed 12 tests, with 3 failures (0 unexpected) in 0.5 seconds"
        Pattern(regex: #"Executed \d+ tests?, with (\d+) failures?"#, group: 1),
        // swift-testing: "Test run with 12 tests failed after 0.5 seconds with 3 issues"
        Pattern(regex: #"Test run with \d+ tests? failed .*?with (\d+) issues?"#, group: 1),
        // node --test TAP summary: "# fail 3"
        Pattern(regex: #"(?m)^#\s*fail\s+(\d+)\s*$"#, group: 1),
        // pytest: "=== 3 failed, 9 passed in 1.2s ==="
        Pattern(regex: #"(\d+) failed"#, group: 1),
        // jest: "Tests:  3 failed, 9 passed, 12 total"
        Pattern(regex: #"Tests:\s+(\d+) failed"#, group: 1),
        // go test: "FAIL\tpkg/foo\t0.5s" — no count in the output, so each
        // failing package line counts as one.
        Pattern(regex: #"(?m)^--- FAIL: "#, group: 0)
    ]

    /// The number of failing tests in `output`, or `nil` when unrecognised.
    ///
    /// A recognised runner reporting zero failures returns `0` (distinct from
    /// `nil`): a stage that exits non-zero while reporting `0 failures` failed
    /// for some other reason — a compile error, a crash — and the loop should
    /// know the count is genuinely zero rather than unknown.
    static func parseFailureCount(_ output: String) -> Int? {
        for pattern in patterns {
            if pattern.group == 0 {
                // Counting pattern: the number of matches IS the score.
                let count = matchCount(pattern.regex, in: output)
                if count > 0 { return count }
                continue
            }
            if let value = firstCapture(pattern.regex, group: pattern.group, in: output) {
                return value
            }
        }
        // XCTest and swift-testing both print a zero-failure summary on success;
        // recognising those means a passing run scores 0 rather than nil.
        if output.range(of: #"Executed \d+ tests?, with 0 failures"#, options: .regularExpression) != nil {
            return 0
        }
        return nil
    }

    private static func firstCapture(_ regex: String, group: Int, in text: String) -> Int? {
        guard let re = try? NSRegularExpression(pattern: regex),
              let match = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > group,
              let range = Range(match.range(at: group), in: text)
        else { return nil }
        return Int(text[range])
    }

    private static func matchCount(_ regex: String, in text: String) -> Int {
        guard let re = try? NSRegularExpression(pattern: regex) else { return 0 }
        return re.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
    }
}
