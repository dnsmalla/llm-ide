import CryptoKit
import Foundation

/// What a test runner's output says failed: the failing test ids and where the
/// errors were reported. Shared by the Loop (stall detection, repair prompt)
/// and the regression sweep's fault repairer, hence `Core`.
struct TestFailureExtraction: Equatable {
    /// Failing test ids, sorted and de-duplicated.
    var ids: [String] = []
    /// `file:line: message` (or the runner's nearest equivalent), in output order.
    var locations: [String] = []
}

/// One extractor per runner (XCTest, swift-testing, node TAP, jest, pytest, go)
/// plus a generic error-line fallback used to build the repair excerpt.
///
/// Pure and not actor-bound. Every extractor is anchored on wording that only
/// its own runner prints, so running all of them over one output is safe — and
/// needed, because `swift test` prints XCTest AND swift-testing.
enum TestFailureExtractor {
    // MARK: Extraction

    static func extract(_ output: String) -> TestFailureExtraction {
        var ids = Set<String>()
        var locations: [String] = []
        func add(_ id: String) {
            let trimmed = id.trimmingCharacters(in: .whitespaces)
            if !trimmed.isEmpty { ids.insert(trimmed) }
        }
        func loc(_ text: String) {
            if !locations.contains(text) { locations.append(text) }
        }

        // XCTest: "Test Case '-[Mod.Class method]' failed (0.044 seconds)."
        for m in captures(#"(?m)^Test Case '-\[(\S+) (\S+)\]' failed"#, output) where m.count == 3 {
            add("\(m[1])/\(m[2])")
        }
        // XCTest: "/path/T.swift:6: error: -[Mod.Class method] : XCTAssert… failed"
        for m in captures(#"(?m)^(\S+:\d+): error: -\[\S+ \S+\] : (.*)$"#, output) where m.count == 3 {
            loc("\(m[1]): \(m[2])")
        }
        // swift-testing: "✘ Test swFails() failed after 0.001 seconds with 1 issue."
        for m in captures(#"(?m)^✘ Test (.+?) failed after"#, output) where m.count == 2 {
            if !m[1].hasPrefix("run with") { add(m[1].trimmingCharacters(in: CharacterSet(charactersIn: "\""))) }
        }
        // swift-testing: "✘ Test swFails() recorded an issue at T.swift:10:28: Expectation failed: …"
        for m in captures(#"(?m)^✘ Test .+? recorded an issue at (\S+?:\d+)(?::\d+)?: (.*)$"#, output) where m.count == 3 {
            loc("\(m[1]): \(m[2])")
        }
        // node TAP: "not ok 2 - subtracts wrongly", then "location: '/p/a.test.mjs:3:1'".
        for m in captures(#"(?m)^\s*not ok \d+ - (.+?)(?: # .*)?$"#, output) where m.count == 2 { add(m[1]) }
        for m in captures(#"(?m)^\s*location: '(.+?:\d+)(?::\d+)?'"#, output) where m.count == 2 { loc(m[1]) }
        // jest: "  ● Suite › test name" (not "● Test suite failed to run" headers' details).
        for m in captures(#"(?m)^\s*● (.+?)\s*$"#, output) where m.count == 2 {
            if !m[1].hasPrefix("Console") { add(m[1]) }
        }
        // jest stack frames: "at Object.<anonymous> (src/a.test.js:12:5)"
        for m in captures(#"(?m)^\s+at .*?\((?!node:)([^()\s]+\.[a-z]+:\d+):\d+\)"#, output).prefix(10) where m.count == 2 {
            loc(m[1])
        }
        // pytest: "FAILED tests/test_a.py::test_b - AssertionError: …"
        for m in captures(#"(?m)^FAILED (\S+)"#, output) where m.count == 2 { add(m[1]) }
        // pytest: "tests/test_a.py:12: AssertionError"
        for m in captures(#"(?m)^(\S+\.py:\d+): (\w*(?:Error|Exception|Failed).*)$"#, output) where m.count == 3 {
            loc("\(m[1]): \(m[2])")
        }
        // go: "--- FAIL: TestFoo (0.00s)" (subtests indented) + "    foo_test.go:12: message"
        for m in captures(#"(?m)^\s*--- FAIL: (\S+)"#, output) where m.count == 2 { add(m[1]) }
        for m in captures(#"(?m)^\s+(\S+\.go:\d+): (.*)$"#, output) where m.count == 3 {
            loc("\(m[1]): \(m[2])")
        }
        return TestFailureExtraction(ids: ids.sorted(), locations: locations)
    }

    /// Hash of the sorted failing test ids, or `nil` when none could be
    /// extracted (the caller then falls back to hashing the output). Two runs
    /// failing the same tests hash alike whatever else changed in the output.
    static func failureSetHash(_ output: String) -> String? {
        let ids = extract(output).ids
        guard !ids.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(ids.joined(separator: "\n").utf8))
        return "set:" + digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Repair excerpt

    /// Narrow: lines that are error REPORTS (see `StageOutputParser.firstErrorLines`).
    static let errorLinePattern =
        #"(?:^|[\s:])(?:error|ERROR|Error):|[Ff]atal error|(?:^|\s)(?:--- )?FAIL(?::|\s|$)"#
    /// Broad: adds each runner's failure markers, for picking excerpt windows.
    private static let excerptPattern =
        errorLinePattern + #"|✘|✖|not ok \d|^\s*● |^FAILED |Assertion|recorded an issue|panic:"#

    static let errorShare = 0.6
    static let contextLines = 5

    /// The part of `output` the repairing agent needs: the error lines with
    /// ±5 lines of context (windows merged, repeated lines dropped, at most
    /// 60% of `budget`), then as much of the tail as remains. Output within the
    /// budget is returned whole. A bare suffix lost errors printed early; a
    /// bare prefix lost the summary — this keeps both ends of the story.
    static func repairExcerpt(_ output: String, budget: Int) -> String {
        guard output.count > budget else { return output }
        let lines = output.components(separatedBy: .newlines)
        let hits = lines.indices.filter {
            lines[$0].range(of: excerptPattern, options: .regularExpression) != nil
        }
        // Merge ±context windows into ranges.
        var ranges: [ClosedRange<Int>] = []
        for i in hits {
            let r = max(0, i - contextLines)...min(lines.count - 1, i + contextLines)
            if let last = ranges.last, r.lowerBound <= last.upperBound + 1 {
                ranges[ranges.count - 1] = last.lowerBound...max(last.upperBound, r.upperBound)
            } else {
                ranges.append(r)
            }
        }
        let errorBudget = Int(Double(budget) * errorShare)
        var seen = Set<String>()
        var parts: [String] = []
        var used = 0
        outer: for r in ranges {
            var chunk: [String] = []
            for i in r {
                let line = lines[i]
                if !line.trimmingCharacters(in: .whitespaces).isEmpty, !seen.insert(line).inserted { continue }
                chunk.append(line)
            }
            let text = chunk.joined(separator: "\n")
            if used + text.count + 1 > errorBudget {
                // Keep what fits of the first window rather than nothing.
                if parts.isEmpty { parts.append(String(text.prefix(errorBudget))); used = errorBudget }
                break outer
            }
            parts.append(text)
            used += text.count + 1
        }
        let tailBudget = max(0, budget - used - 40)
        let tail = String(output.suffix(tailBudget))
        guard !parts.isEmpty else { return tail }
        return parts.joined(separator: "\n[…]\n") + "\n[… tail of output …]\n" + tail
    }

    // MARK: Regex helper

    /// Every match as `[whole, group1, …]`.
    private static func captures(_ pattern: String, _ text: String) -> [[String]] {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        return re.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { m in
            (0..<m.numberOfRanges).map { i in
                Range(m.range(at: i), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }
}
