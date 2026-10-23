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
        // compiler: "/path/F.swift:12:5: error: cannot find 'x' in scope"
        for m in captures(#"(?m)^(\S+:\d+):\d+: error: (.*)$"#, output) where m.count == 3 {
            loc("\(m[1]): \(m[2])")
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
        // node TAP: "not ok 2 - subtracts wrongly" -> "parent/child" from "# Subtest:"
        // nesting (indent); `# TODO` / `# SKIP` are not failures. Then "location: '/p/a.test.mjs:3:1'".
        var stack: [(indent: Int, name: String)] = []
        for line in output.components(separatedBy: "\n") {
            let indent = line.prefix { $0 == " " }.count
            let body = line.dropFirst(indent)
            if body.hasPrefix("# Subtest: ") {
                while let last = stack.last, last.indent >= indent { stack.removeLast() }
                stack.append((indent, String(body.dropFirst(11))))
            } else if body.hasPrefix("not ok "),
                      let m = captures(#"^not ok \d+ - (.+?)(?: # (TODO|SKIP).*)?$"#, String(body)).first,
                      m.count == 3, m[2].isEmpty {
                add((stack.filter { $0.indent < indent }.map(\.name) + [m[1]]).joined(separator: "/"))
            }
        }
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
        for m in captures(#"(?m)^FAILED (\S+::\S+|\S+\.py\S*)"#, output) where m.count == 2 { add(m[1]) }
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

    /// The part of `output` the repairing agent needs: a one-line header of
    /// failing ids and locations, the error lines with ±5 lines of context
    /// (windows merged, repeated lines dropped, at most 60% of the space after
    /// the header), then as much of the tail as remains. Never longer than
    /// `budget`. Output within the budget is returned whole.
    static func repairExcerpt(_ output: String, budget: Int) -> String {
        guard output.count > budget else { return output }
        let extraction = extract(output)
        var header = ""
        if !extraction.ids.isEmpty || !extraction.locations.isEmpty {
            var bits: [String] = []
            if !extraction.ids.isEmpty { bits.append("Failing: " + extraction.ids.prefix(10).joined(separator: ", ")) }
            if !extraction.locations.isEmpty { bits.append("at: " + extraction.locations.prefix(10).joined(separator: ", ")) }
            header = String(bits.joined(separator: " / ").prefix(budget / 5)) + "\n"
        }
        let room = budget - header.count
        let lines = output.components(separatedBy: .newlines)
        let hits = lines.indices.filter {
            lines[$0].range(of: excerptPattern, options: .regularExpression) != nil
        }
        var ranges: [ClosedRange<Int>] = []
        for i in hits {
            let r = max(0, i - contextLines)...min(lines.count - 1, i + contextLines)
            if let last = ranges.last, r.lowerBound <= last.upperBound + 1 {
                ranges[ranges.count - 1] = last.lowerBound...max(last.upperBound, r.upperBound)
            } else {
                ranges.append(r)
            }
        }
        let errorBudget = Int(Double(room) * errorShare)
        let sep = "\n[…]\n"
        let tailMarker = "\n[… tail of output …]\n"
        var seen = Set<String>()
        var parts: [String] = []
        var used = 0
        for r in ranges {
            var chunk: [String] = []
            var newSeen = seen
            for i in r {
                let line = lines[i]
                if !line.trimmingCharacters(in: .whitespaces).isEmpty, !newSeen.insert(line).inserted { continue }
                chunk.append(line)
            }
            let text = chunk.joined(separator: "\n")
            let cost = text.count + (parts.isEmpty ? 0 : sep.count)
            if used + cost > errorBudget {
                if parts.isEmpty, errorBudget > 0 { parts.append(String(text.prefix(errorBudget))); used = errorBudget }
                continue
            }
            seen = newSeen
            parts.append(text)
            used += cost
        }
        let errorPart = parts.joined(separator: sep)
        guard !errorPart.isEmpty else { return header + String(output.suffix(max(0, room))) }
        let tailRoom = room - errorPart.count - tailMarker.count
        var tail = ""
        if tailRoom > 0 {
            let tailLines = String(output.suffix(tailRoom)).components(separatedBy: "\n")
                .filter { $0.trimmingCharacters(in: .whitespaces).isEmpty || !seen.contains($0) }
            tail = tailMarker + tailLines.joined(separator: "\n")
        }
        return String((header + errorPart + tail).prefix(budget))
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
