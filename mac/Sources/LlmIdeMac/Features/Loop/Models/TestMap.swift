import Foundation

public struct TestMapEntry: Codable, Equatable {
    public var path: String
    public var function: String
    public var line: Int
    public var fanIn: Int
    public var loc: Int
    public var testedBy: [String]
    /// nil (an old TEST-MAP.json) reads as `.domainLogic`.
    public var quadrant: CodeQuadrant?

    public init(path: String, function: String, line: Int, fanIn: Int, loc: Int, testedBy: [String],
                quadrant: CodeQuadrant? = nil) {
        self.path = path; self.function = function; self.line = line
        self.fanIn = fanIn; self.loc = loc; self.testedBy = testedBy
        self.quadrant = quadrant
    }

    public var effectiveQuadrant: CodeQuadrant { quadrant ?? .domainLogic }
}

public struct TestMap: Codable, Equatable {
    public var generatedAt: Date
    public var source: String                 // "graph" | "files" (fallback)
    public var entries: [TestMapEntry]        // untested-first, fanIn desc, loc desc, path, name
    public var untestedFunctions: Int
    public var testedFunctions: Int
    public var untestedFiles: Int
    public var counters: [String: Double]

    public init(generatedAt: Date, source: String, entries: [TestMapEntry],
                untestedFunctions: Int, testedFunctions: Int, untestedFiles: Int) {
        self.generatedAt = generatedAt; self.source = source; self.entries = entries
        self.untestedFunctions = untestedFunctions; self.testedFunctions = testedFunctions
        self.untestedFiles = untestedFiles
        self.counters = ["untestedFunctions": Double(untestedFunctions),
                         "testedFunctions": Double(testedFunctions),
                         "untestedFiles": Double(untestedFiles),
                         "untestedDomainFunctions": Double(entries.filter {
                             $0.testedBy.isEmpty && $0.effectiveQuadrant == .domainLogic }.count)]
    }

    /// after - before, per counter.
    public static func delta(before: TestMap, after: TestMap) -> [String: Double] {
        var out: [String: Double] = [:]
        for k in Set(before.counters.keys).union(after.counters.keys) {
            out[k] = (after.counters[k] ?? 0) - (before.counters[k] ?? 0)
        }
        return out
    }

    private func functionLines(_ list: [TestMapEntry], limit: Int) -> String {
        if list.isEmpty { return "- none\n" }
        return list.prefix(limit).map {
            "- \($0.path):\($0.line) \($0.function) — fan-in \($0.fanIn), file \($0.loc) lines\n"
        }.joined()
    }

    /// One line per file, ranked by fan-in then size, then path.
    private func fileLines(_ list: [TestMapEntry], limit: Int) -> String {
        var byFile: [String: TestMapEntry] = [:]
        for e in list where byFile[e.path] == nil { byFile[e.path] = e }
        if byFile.isEmpty { return "- none\n" }
        let ranked = byFile.values.sorted { ($1.fanIn, $1.loc, $0.path) < ($0.fanIn, $0.loc, $1.path) }
        return ranked.prefix(limit).map { "- \($0.path) — fan-in \($0.fanIn), \($0.loc) lines\n" }.joined()
    }

    private func pathLines(_ list: [TestMapEntry], limit: Int) -> String {
        let paths = Set(list.map(\.path)).sorted()
        if paths.isEmpty { return "- none\n" }
        return paths.prefix(limit).map { "- \($0)\n" }.joined()
    }

    /// TEST-MAP.md
    public func render(limit: Int = 40) -> String {
        var out = "# Test map (\(source), \(ISO8601DateFormatter().string(from: generatedAt)))\n\n"
        out += "| counter | value |\n|---|---|\n"
        for k in counters.keys.sorted() { out += "| \(k) | \(Int(counters[k] ?? 0)) |\n" }
        let untested = entries.filter { $0.testedBy.isEmpty }
        out += "\n## Unit-test candidates (domain logic / algorithms)\n"
        out += functionLines(untested.filter { $0.effectiveQuadrant == .domainLogic }, limit: limit)
        out += "\n## Integration-test candidates (controllers / pipelines)\n"
        out += functionLines(untested.filter { $0.effectiveQuadrant == .controller }, limit: limit)
        out += "\n## Refactor first (over-complex — no tests until split)\n"
        out += fileLines(untested.filter { $0.effectiveQuadrant == .overComplex }, limit: 25)
        out += "\n## Not tested by policy (trivial)\n"
        out += pathLines(untested.filter { $0.effectiveQuadrant == .trivial }, limit: 25)
        out += "\n## How to read\n"
        out += "- untestedFunctions: functions no test file references; testedFunctions: the rest; untestedFiles: source files with at least one eligible function and none of them tested.\n"
        out += "- A function `f` of file `p` is tested by a test file in the matching test root when the test's tokens (identifiers and double-quoted string contents) contain `f` exactly, and the test maps to the same source stem as `p` or contains the file's name as a token.\n"
        out += "- Each file is classified by the test guideline matrix: domain logic gets unit tests, controllers/pipelines get integration tests, over-complex files are refactored before testing, trivial files are not tested.\n"
        out += "- init, deinit, body, main, description and `_`-prefixed names are skipped.\n"
        out += "- Counters are information, not a goal: the loop never fails because a count did not move.\n"
        return out
    }
}

/// The Test Map Check's verdict. The check is informational: a counter that did
/// not move is never a reason to fail the loop.
public enum TestMapCheck {
    /// Always passes. `note` is set (advisory) when the writer changed files but
    /// the untested-function count did not fall.
    public static func mapCheckOutcome(delta: [String: Double], writerChanged: Bool) -> (passed: Bool, note: String?) {
        if writerChanged, (delta["untestedFunctions"] ?? 0) >= 0 {
            return (true, "Test Write changed files but untestedFunctions did not fall (advisory)")
        }
        return (true, nil)
    }
}
