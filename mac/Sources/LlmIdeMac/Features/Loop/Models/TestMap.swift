import Foundation

public struct TestMapEntry: Codable, Equatable {
    public var path: String
    public var function: String
    public var line: Int
    public var fanIn: Int
    public var loc: Int
    public var testedBy: [String]

    public init(path: String, function: String, line: Int, fanIn: Int, loc: Int, testedBy: [String]) {
        self.path = path; self.function = function; self.line = line
        self.fanIn = fanIn; self.loc = loc; self.testedBy = testedBy
    }
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
                         "untestedFiles": Double(untestedFiles)]
    }

    /// after - before, per counter.
    public static func delta(before: TestMap, after: TestMap) -> [String: Double] {
        var out: [String: Double] = [:]
        for k in Set(before.counters.keys).union(after.counters.keys) {
            out[k] = (after.counters[k] ?? 0) - (before.counters[k] ?? 0)
        }
        return out
    }

    /// TEST-MAP.md
    public func render(limit: Int = 40) -> String {
        var out = "# Test map (\(source), \(ISO8601DateFormatter().string(from: generatedAt)))\n\n"
        out += "| counter | value |\n|---|---|\n"
        for k in counters.keys.sorted() { out += "| \(k) | \(Int(counters[k] ?? 0)) |\n" }
        out += "\n## Untested functions (top \(limit) by fan-in)\n"
        let untested = entries.filter { $0.testedBy.isEmpty }
        if untested.isEmpty { out += "- none\n" }
        for e in untested.prefix(limit) {
            out += "- \(e.path):\(e.line) \(e.function) — fan-in \(e.fanIn), file \(e.loc) lines\n"
        }
        out += "\n## Files with no test at all\n"
        var byFile: [String: (tested: Bool, loc: Int, fanIn: Int)] = [:]
        for e in entries {
            let cur = byFile[e.path] ?? (false, e.loc, e.fanIn)
            byFile[e.path] = (cur.tested || !e.testedBy.isEmpty, e.loc, e.fanIn)
        }
        let bare = byFile.filter { !$0.value.tested }
            .sorted { ($1.value.fanIn, $1.value.loc, $0.key) < ($0.value.fanIn, $0.value.loc, $1.key) }
        if bare.isEmpty { out += "- none\n" }
        for (path, v) in bare.prefix(25) { out += "- \(path) — fan-in \(v.fanIn), \(v.loc) lines\n" }
        out += "\n## How to read\n"
        out += "- untestedFunctions: functions no test file references; testedFunctions: the rest; untestedFiles: source files with at least one eligible function and none of them tested.\n"
        out += "- A function `f` of file `p` is tested by a test file in the matching test root when the test's tokens (identifiers and double-quoted string contents) contain `f` exactly, and the test maps to the same source stem as `p` or contains the file's name as a token.\n"
        out += "- init, deinit, body, main, description and `_`-prefixed names are skipped.\n"
        return out
    }
}
